export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const { messages, systemInstruction } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: 'Invalid messages'
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: 'Server missing GEMINI_API_KEY'
      });
    }

    /*
     * ---------------------------------------------------------
     * REQUEST SAFETY LIMITS
     * ---------------------------------------------------------
     */

    const MAX_MESSAGES = 12;
    const MAX_MESSAGE_CHARS = 30000;
    const MAX_TOTAL_CHARS = 90000;

    const recentMessages = messages
      .filter(
        (m) =>
          m &&
          typeof m.content === 'string' &&
          m.content.trim() !== ''
      )
      .slice(-MAX_MESSAGES);

    if (!recentMessages.length) {
      return res.status(400).json({
        error: 'No usable messages were provided'
      });
    }

    /*
     * Limit each individual message.
     */

    const trimmedMessages = recentMessages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      content: m.content.slice(0, MAX_MESSAGE_CHARS)
    }));

    /*
     * Limit total request size.
     */

    let totalChars = 0;
    const safeMessages = [];

    for (const message of trimmedMessages) {
      if (totalChars >= MAX_TOTAL_CHARS) {
        break;
      }

      const remaining = MAX_TOTAL_CHARS - totalChars;
      const content = message.content.slice(0, remaining);

      safeMessages.push({
        role: message.role,
        content
      });

      totalChars += content.length;
    }

    if (!safeMessages.length) {
      return res.status(400).json({
        error: 'Request context is too large.'
      });
    }

    /*
     * ---------------------------------------------------------
     * CONVERT TO GEMINI FORMAT
     * ---------------------------------------------------------
     */

    const contents = safeMessages.map((m) => ({
      role: m.role,
      parts: [
        {
          text: m.content
        }
      ]
    }));

    const body = {
      contents
    };

    /*
     * ---------------------------------------------------------
     * SYSTEM INSTRUCTION
     * ---------------------------------------------------------
     */

    if (
      typeof systemInstruction === 'string' &&
      systemInstruction.trim()
    ) {
      body.systemInstruction = {
        parts: [
          {
            text: systemInstruction.slice(0, 12000)
          }
        ]
      };
    }

    /*
     * ---------------------------------------------------------
     * GEMINI REQUEST
     * ---------------------------------------------------------
     */

    const modelUrl =
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=' +
      encodeURIComponent(apiKey);

    async function callGemini(requestBody) {
      const response = await fetch(modelUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const responseText = await response.text();

      let data;

      try {
        data = JSON.parse(responseText);
      } catch {
        return {
          response,
          data: null,
          invalidJson: true
        };
      }

      return {
        response,
        data,
        invalidJson: false
      };
    }

    /*
     * ---------------------------------------------------------
     * DETECT TEMPORARY HIGH-DEMAND / OVERLOAD ERRORS
     * ---------------------------------------------------------
     */

    function isTemporaryAvailabilityError(response, data) {
      const message = String(
        data?.error?.message || ''
      ).toLowerCase();

      if (response.status === 503) {
        return true;
      }

      if (response.status === 429) {
        return (
          message.includes('high demand') ||
          message.includes('overloaded') ||
          message.includes('temporarily') ||
          message.includes('try again later')
        );
      }

      return (
        message.includes('high demand') ||
        message.includes('model is currently experiencing') ||
        message.includes('temporarily unavailable')
      );
    }

    /*
     * ---------------------------------------------------------
     * WAIT FUNCTION
     * ---------------------------------------------------------
     */

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /*
     * ---------------------------------------------------------
     * AUTOMATIC RETRY
     *
     * Initial request
     * ↓
     * Wait 1.2 seconds → retry
     * ↓
     * Wait 3 seconds → retry
     *
     * Only temporary availability errors are retried.
     * ---------------------------------------------------------
     */

    async function callGeminiWithRetry(requestBody) {
      const delays = [1200, 3000];

      let lastResult = null;

      for (
        let attempt = 0;
        attempt <= delays.length;
        attempt++
      ) {
        if (attempt > 0) {
          await sleep(delays[attempt - 1]);
        }

        const result = await callGemini(requestBody);

        lastResult = result;

        if (result.invalidJson) {
          return result;
        }

        if (
          result.response.ok ||
          !isTemporaryAvailabilityError(
            result.response,
            result.data
          )
        ) {
          return result;
        }
      }

      return lastResult;
    }

    /*
     * ---------------------------------------------------------
     * FIRST GEMINI REQUEST
     * ---------------------------------------------------------
     */

    let result = await callGeminiWithRetry(body);

    let response = result.response;
    let data = result.data;

    /*
     * Invalid response from Gemini.
     */

    if (result.invalidJson) {
      return res.status(502).json({
        error: 'Gemini returned an invalid response.'
      });
    }

    /*
     * ---------------------------------------------------------
     * GEMINI ERROR HANDLING
     * ---------------------------------------------------------
     */

    if (!response.ok) {
      const geminiMessage =
        data?.error?.message ||
        'Gemini API request failed.';

      /*
       * Temporary high-demand / overloaded model.
       */

      if (
        isTemporaryAvailabilityError(
          response,
          data
        )
      ) {
        return res.status(503).json({
          error:
            'Gemini is temporarily experiencing high demand. ' +
            'Mini ChatGPT tried automatically, but the model is still busy. ' +
            'Please try again in a few seconds.',
          details: geminiMessage,
          retryable: true
        });
      }

      /*
       * Actual quota problem.
       */

      if (response.status === 429) {
        return res.status(429).json({
          error:
            'Gemini quota has been exceeded. ' +
            'Please wait for the quota to reset or use a Gemini API project/plan with available quota.',
          details: geminiMessage,
          retryable: false
        });
      }

      /*
       * Other Gemini errors.
       */

      return res.status(response.status).json({
        error: geminiMessage,
        retryable: false
      });
    }

    /*
     * ---------------------------------------------------------
     * EXTRACT GEMINI RESPONSE
     * ---------------------------------------------------------
     */

    let parts =
      data?.candidates?.[0]?.content?.parts || [];

    let text = parts
      .map((part) => part?.text || '')
      .join('');

    /*
     * ---------------------------------------------------------
     * RECITATION HANDLING
     * ---------------------------------------------------------
     *
     * Gemini can sometimes finish with RECITATION without
     * returning usable text.
     *
     * We retry once with a stronger instruction to produce
     * an original response.
     * ---------------------------------------------------------
     */

    if (!text.trim()) {
      const finishReason =
        data?.candidates?.[0]?.finishReason;

      const blockReason =
        data?.promptFeedback?.blockReason;

      /*
       * RECITATION retry.
       */

      if (finishReason === 'RECITATION') {
        const retryBody = JSON.parse(
          JSON.stringify(body)
        );

        const originalInstruction =
          typeof retryBody.systemInstruction?.parts?.[0]?.text ===
          'string'
            ? retryBody.systemInstruction.parts[0].text
            : '';

        retryBody.systemInstruction = {
          parts: [
            {
              text:
                originalInstruction +
                '\n\nIMPORTANT RETRY RULE: Return an original response generated for this user request. Do not reproduce, quote, or continue any source text, copyrighted text, webpage text, code from an identified source, or other material verbatim. If the request contains source material, transform it and respond in your own words.'
            }
          ]
        };

        /*
         * Retry exactly once.
         */

        const retryResult =
          await callGemini(retryBody);

        if (!retryResult.invalidJson) {
          response = retryResult.response;
          data = retryResult.data;

          /*
           * Retry itself returned an error.
           */

          if (!response.ok) {
            const retryMessage =
              data?.error?.message ||
              'Gemini retry request failed.';

            return res.status(response.status).json({
              error: retryMessage
            });
          }

          /*
           * Extract retry response.
           */

          const retryParts =
            data?.candidates?.[0]?.content?.parts || [];

          const retryText = retryParts
            .map((part) => part?.text || '')
            .join('');

          if (retryText.trim()) {
            text = retryText;
          }
        }
      }

      /*
       * -------------------------------------------------------
       * IF RECITATION RETRY ALSO FAILED
       * -------------------------------------------------------
       */

      if (!text.trim()) {
        let message =
          'Gemini returned no text.';

        if (blockReason) {
          message +=
            ` Prompt blocked: ${blockReason}.`;
        }

        if (finishReason === 'RECITATION') {
          message +=
            ' Gemini stopped the response because it detected possible source-text reproduction. Please rephrase the request and try again.';
        } else if (finishReason) {
          message +=
            ` Finish reason: ${finishReason}.`;
        }

        return res.status(502).json({
          error: message,
          finishReason:
            finishReason || null
        });
      }
    }

    /*
     * ---------------------------------------------------------
     * SEND RESPONSE TO MINI CHATGPT
     * ---------------------------------------------------------
     */

    res.statusCode = 200;

    res.setHeader(
      'Content-Type',
      'text/event-stream; charset=utf-8'
    );

    res.setHeader(
      'Cache-Control',
      'no-cache, no-transform'
    );

    res.setHeader(
      'Connection',
      'keep-alive'
    );

    res.setHeader(
      'X-Accel-Buffering',
      'no'
    );

    /*
     * Send generated text.
     */

    res.write(
      `data: ${JSON.stringify({
        text
      })}\n\n`
    );

    /*
     * Tell frontend generation is finished.
     */

    res.write(
      `data: ${JSON.stringify({
        done: true
      })}\n\n`
    );

    res.end();

  } catch (error) {
    console.error(
      'Chat API error:',
      error
    );

    /*
     * Normal server error.
     */

    if (!res.headersSent) {
      return res.status(500).json({
        error:
          error?.message ||
          'Server error'
      });
    }

    /*
     * If headers were already sent, send the error
     * through the existing stream.
     */

    res.write(
      `data: ${JSON.stringify({
        error:
          error?.message ||
          'Server error'
      })}\n\n`
    );

    res.end();
  }
    }
