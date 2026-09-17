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
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse&key=' +
        encodeURIComponent(apiKey),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = 'Gemini API request failed.';
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData?.error?.message || errorMessage;
      } catch {}
      return res.status(response.status).json({ error: errorMessage });
    }

    if (!response.body) {
      return res.status(502).json({ error: 'Gemini did not return a stream.' });
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';

      for (const event of events) {
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const jsonText = line.slice(5).trim();
          if (!jsonText || jsonText === '[DONE]') continue;

          try {
            const data = JSON.parse(jsonText);
            if (data?.error) {
              throw new Error(data.error.message || 'Gemini API error');
            }
            const text = data?.candidates?.[0]?.content?.parts
              ?.map(part => part?.text || '')
              .join('') || '';
            if (text) {
              res.write(`data: ${JSON.stringify({ text })}\n\n`);
            }
          } catch (e) {
            if (e?.message && !/Unexpected token|Unexpected end of JSON input/.test(e.message)) {
              throw e;
            }
          }
        }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
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
