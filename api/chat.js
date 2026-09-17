export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Invalid messages' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: 'Server missing ANTHROPIC_API_KEY'
      });
    }

    const anthropicRes = await fetch(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1024,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content
          }))
        })
      }
    );

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      return res.status(anthropicRes.status).json({
        error: data?.error?.message || 'Claude API error'
      });
    }

    const reply = (data.content || [])
      .map(b => b.text || '')
      .join('');

    return res.status(200).json({ reply });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
        }
