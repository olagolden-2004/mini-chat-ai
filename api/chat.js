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
     *
     * The Mini ChatGPT can work with large code files, but
     * sending the entire conversation repeatedly can consume
     * Gemini quota very quickly.
     */

    const MAX_MESSAGES = 12;
    const MAX_MESSAGE_CHARS = 30000;
    const MAX_TOTAL_CHARS = 90000;

    /*
     * Keep only the most recent messages.
     * This prevents an ever-growing conversation from being
     * sent to Gemini on every request.
     */

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
     * Make sure total request size does not become excessive.
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
     * Gemini request.
     */

    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=' +
        encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    const responseText = await response.text();

    let data;

    try {
      data = JSON.parse(responseText);
    } catch {
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

    const parts =
      data?.candidates?.[0]?.content?.parts || [];

    const text = parts
      .map((part) => part?.text || '')
      .join('');

    if (!text.trim()) {
      const finishReason =
        data?.candidates?.[0]?.finishReason;

      const blockReason =
        data?.promptFeedback?.blockReason;

      let message = 'Gemini returned no text.';

      if (blockReason) {
        message += ` Prompt blocked: ${blockReason}.`;
      }

      if (finishReason) {
        message += ` Finish reason: ${finishReason}.`;
      }

      return res.status(502).json({
        error: message
      });
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

    res.write(
      `data: ${JSON.stringify({
        text
      })}\n\n`
    );

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
