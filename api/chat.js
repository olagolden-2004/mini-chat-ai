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
     * Convert to Gemini format.
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
     * System instruction.
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
     * First Gemini request.
     */

    let result = await callGemini(body);

    let response = result.response;
    let data = result.data;

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
       * Quota / rate limit.
       */

      if (response.status === 429) {
        return res.status(429).json({
          error:
            'Gemini quota has been exceeded. ' +
            'The request was not retried automatically. ' +
            'Please wait for the quota to reset or use a Gemini API project/plan with available quota.',
          details: geminiMessage
        });
      }

      return res.status(response.status).json({
        error: geminiMessage
      });
    }

    /*
     * ---------------------------------------------------------
     * EXTRACT RESPONSE
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
     * returning text. Retry exactly once with an instruction
     * asking for an original response.
     */

    if (!text.trim()) {
      const finishReason =
        data?.candidates?.[0]?.finishReason;

      const blockReason =
        data?.promptFeedback?.blockReason;

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
         * Retry only once.
         */

        const retryResult =
          await callGemini(retryBody);

        if (!retryResult.invalidJson) {
          response = retryResult.response;
          data = retryResult.data;

          if (!response.ok) {
            const retryMessage =
              data?.error?.message ||
              'Gemini retry request failed.';

            return res.status(response.status).json({
              error: retryMessage
            });
          }

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
       * If retry also failed.
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
     * STREAM RESPONSE
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
     * Send text.
     */

    res.write(
      `data: ${JSON.stringify({
        text
      })}\n\n`
    );

    /*
     * Tell frontend we're finished.
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

    if (!res.headersSent) {
      return res.status(500).json({
        error:
          error?.message ||
          'Server error'
      });
    }

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
