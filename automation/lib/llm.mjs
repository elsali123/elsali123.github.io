// Claude-powered answers for application questions the user hasn't pre-answered.
// Uses the Anthropic Messages API directly (no SDK dependency).
const API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

// profile: job_profile row; question: label text; options: array of choice
// strings for select/radio questions (empty for free text).
export async function llmAnswer(question, options, profile, job) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const facts = { ...profile };
  delete facts.resume_text; delete facts.common_answers;

  const system = `You fill out job application forms on behalf of a candidate.
Answer questions truthfully based ONLY on the candidate facts, saved answers, and resume below. Never invent employers, degrees, dates, or legal statuses.
- For multiple-choice questions, reply with EXACTLY one of the provided options, verbatim.
- For free-text questions, reply with a concise, professional answer (1-3 sentences unless the question clearly asks for more, e.g. a cover letter or "why us" essay — then 100-200 words).
- For salary/compensation questions on internships, answer flexibly (e.g. "Open to the standard intern rate for this role").
- If the question asks something unknowable from the facts, give the safest honest generic answer rather than fabricating specifics.
Reply with the answer only — no preamble, no quotes.

CANDIDATE FACTS:
${JSON.stringify(facts, null, 1)}

SAVED ANSWERS TO COMMON QUESTIONS:
${JSON.stringify(profile.common_answers || {}, null, 1)}

RESUME TEXT:
${(profile.resume_text || '').slice(0, 6000)}`;

  const user = `Company: ${job.company}\nRole: ${job.title}\n\nApplication question: ${question}` +
    (options?.length ? `\n\nOptions (reply with exactly one):\n${options.map((o) => `- ${o}`).join('\n')}` : '');

  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      // Cache the big system block: the same profile/resume is reused for
      // every question in a run.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let answer = (data.content?.[0]?.text || '').trim();

  // For choice questions, snap to the closest option if the model added fluff.
  if (options?.length && !options.includes(answer)) {
    const lower = answer.toLowerCase();
    answer = options.find((o) => o.toLowerCase() === lower)
      || options.find((o) => lower.includes(o.toLowerCase()) || o.toLowerCase().includes(lower))
      || answer;
  }
  return answer;
}
