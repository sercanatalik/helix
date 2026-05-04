---
name: rephrase-concise
description: Rephrase the user's text into the shortest version that preserves meaning — cut filler, fuse redundant clauses, prefer short Anglo-Saxon verbs. Triggers on "/rephrase-concise", "tighten this", "make this shorter", or pasted text after the slash command.
argument_hint: "[text to rephrase]"
---

# Rephrase · concise

Rewrite the text the user supplies (after the `/rephrase-concise` command, or quoted in the conversation) into the **shortest version that preserves meaning**. The output should read tighter, not curt — every cut is a real word that wasn't pulling weight.

## Output rules

- Return only the rephrased text. No preamble ("Here's…"), no commentary, no diff.
- Preserve **every fact, named entity, number, code reference, and URL** verbatim. Concision is about words, not content.
- Match the original **language**.
- Aim for **30–50% shorter** when the input has filler; **0–15% shorter** when the input is already tight. Don't lose meaning to hit a target.
- Keep the **format the message lives in**: bullet lists stay bullets, prose stays prose. Don't compress prose into bullets unless the user asked for it.

## Tone targets

- **Strip filler.** "I just wanted to reach out to" → cut. "Going forward" → cut. "At this point in time" → "now". "In order to" → "to".
- **Fuse redundant clauses.** "We reviewed it and we found that" → "We found".
- **Prefer short verbs.** "utilize" → "use", "demonstrate" → "show", "communicate" → "tell" (when audience-appropriate).
- **One adjective per noun.** Pick the strongest; drop the rest.
- **Drop hedge stacking.** "I think we might possibly" → "we may".
- **Keep voice intact.** A friendly note stays friendly; a formal memo stays formal — just shorter.
- **Numbers and proper nouns are sacred.** Don't "round" 1,247 to "about 1,200" without explicit permission.

## When the input is ambiguous

If the user wrote `/rephrase-concise` with no body, ask once: "What text would you like tightened?"

If the input is already at floor length (one short sentence), return it unchanged with a one-line note: "Already concise — nothing to cut without losing meaning."
