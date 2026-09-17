export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, systemInstruction } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Invalid messages' });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: 'Server missing GEMINI_API_KEY'
      });
    }

    const contents = messages
      .filter(
        (m) =>
          m &&
          typeof m.content === 'string' &&
          m.content.trim() !== ''
      )
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    if (!contents.length) {
      return res.status(400).json({
        error: 'No usable messages were provided'
      });
    }

    const body = { contents };

    if (
      typeof systemInstruction === 'string' &&
      systemInstruction.trim()
    ) {
      body.systemInstruction = {
        parts: [{ text: systemInstruction.slice(0, 12000) }]
      };
    }

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

    if (!response.ok) {
      return res.status(response.status).json({
        error:
          data?.error?.message ||
          'Gemini API request failed.'
      });
    }

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

      return res.status(502).json({ error: message });
    }

    res.statusCode = 200;
    res.setHeader(
      'Content-Type',
      'text/event-stream; charset=utf-8'
    );
    res.setHeader(
      'Cache-Control',
      'no-cache, no-transform'
    );
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(
      `data: ${JSON.stringify({ text })}\n\n`
    );

    res.write(
      `data: ${JSON.stringify({ done: true })}\n\n`
    );

    res.end();
  } catch (error) {
    console.error('Chat API error:', error);

    if (!res.headersSent) {
      return res.status(500).json({
        error: error?.message || 'Server error'
      });
    }

    res.write(
      `data: ${JSON.stringify({
        error: error?.message || 'Server error'
      })}\n\n`
    );

    res.end();
  }
}
