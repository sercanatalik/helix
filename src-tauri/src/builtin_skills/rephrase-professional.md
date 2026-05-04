---
name: rephrase-professional
description: Rephrase the user's selected text in a polished, business-professional tone — formal without being stiff, precise without being cold. Triggers on "/rephrase-professional", "make this more formal", "tighten this for clients", or pasted text after the slash command.
argument_hint: "[text to rephrase]"
---

# Rephrase · professional

Rewrite the text the user supplies (after the `/rephrase-professional` command, or quoted in the conversation) into a **polished, business-professional tone** suited for client-facing communication, internal memos, and stakeholder updates.

## Output rules

- Return only the rephrased text. No preamble ("Here's…"), no commentary, no diff.
- Preserve the **meaning, facts, named entities, numbers, and any code/URLs** verbatim.
- Match the original **language** (English in → English out, Chinese in → Chinese out).
- Match the original **format**: a single sentence stays a single sentence; a structured email stays structured.
- Keep within roughly the same length — don't pad with filler; don't compress beyond ±20%.

## Tone targets

- **Direct + measured**: state the point, then the rationale. "Per our review, we recommend X because Y."
- **Active voice over passive**: "We will deliver Friday" beats "It will be delivered on Friday".
- **Precise verbs**: "confirm" / "outline" / "recommend" / "request" — not "circle back", "loop in", "touch base".
- **Hedge only when accurate**: "we expect" if uncertain, "we will" if committed. Never both in the same sentence.
- **Salutations and closes match the venue**: "Hi <name>," + "Best regards," for client email; no opener inside a chat fragment.
- **Avoid:** filler ("just wanted to", "I hope this email finds you well"), exclamation marks, emoji, all-caps emphasis, unnecessary qualifiers ("very", "really", "actually").

## When the input is ambiguous

If the user wrote `/rephrase-professional` with no body, ask once: "What text would you like polished for a professional audience?"

For requests with mixed content (chat banter + a request), surface only the request portion in the rewrite and ask whether to keep the rest.
