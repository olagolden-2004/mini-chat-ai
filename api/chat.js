export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  try {
    const { messages } = req.body || {};

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
      Convert the chat messages into Gemini format.
      Empty assistant messages are ignored.
    */
    const contents = messages
      .filter(
        (m) =>
          m &&
          typeof m.content === 'string' &&
          m.content.trim() !== ''
      )
      .map((m) => ({
        role:
          m.role === 'assistant'
            ? 'model'
            : 'user',
        parts: [
          {
            text: m.content
          }
        ]
      }));

    if (contents.length === 0) {
      return res.status(400).json({
        error: 'No usable messages were provided'
      });
    }

    /*
      Use Gemini's normal generateContent endpoint.
      This avoids manually parsing Gemini's streaming
      response, while we still send an SSE response
      to your existing frontend.
    */
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' +
        encodeURIComponent(apiKey),
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          contents
        })
      }
    );

    const responseText = await response.text();

    let data = null;

    try {
      data = JSON.parse(responseText);
    } catch {
      return res.status(502).json({
        error:
          'Gemini returned an invalid response.'
      });
    }

    /*
      Handle Gemini API errors clearly.
    */
    if (!response.ok) {
      const apiError =
        data?.error?.message ||
        'Gemini API request failed.';

      return res.status(response.status).json({
        error: apiError
      });
    }

    /*
      Extract Gemini's answer.
    */
    const parts =
      data?.candidates?.[0]?.content?.parts || [];

    const text = parts
      .map((part) => part?.text || '')
      .join('');

    /*
      If Gemini returned no text, give the frontend
      a useful error instead of the vague
      "empty response" message.
    */
    if (!text.trim()) {
      const finishReason =
        data?.candidates?.[0]?.finishReason;

      const blockReason =
        data?.promptFeedback?.blockReason;

      let errorMessage =
        'Gemini returned no text.';

      if (blockReason) {
        errorMessage +=
          ` Prompt blocked: ${blockReason}.`;
      } else if (finishReason) {
        errorMessage +=
          ` Finish reason: ${finishReason}.`;
      }

      return res.status(502).json({
        error: errorMessage
      });
    }

    /*
      Send the answer using the exact SSE format
      your current index.html expects.
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
        text: text
      })}\n\n`
    );

    res.write(
      `data: ${JSON.stringify({
        done: true
      })}\n\n`
    );

    res.end();

  } catch (error) {
    console.error('Chat API error:', error);

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
