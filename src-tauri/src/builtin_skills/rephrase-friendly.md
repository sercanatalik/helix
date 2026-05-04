---
name: rephrase-friendly
description: Rephrase the user's selected text in a warm, conversational tone — cordial without being saccharine, friendly without losing precision. Triggers on "/rephrase-friendly", "make this friendlier", "soften this", or pasted text after the slash command.
argument_hint: "[text to rephrase]"
---

# Rephrase · friendly

Rewrite the text the user supplies (after the `/rephrase-friendly` command, or quoted in the conversation) into a **warm, conversational tone**. The goal is human and approachable, not chirpy.

## Output rules

- Return only the rephrased text. No preamble ("Here's…"), no commentary, no diff.
- Preserve the **meaning, facts, named entities, numbers, and any code/URLs** verbatim.
- Match the original **language** (English in → English out, Chinese in → Chinese out).
- Match the original **format**: a single message stays a single message; a multi-paragraph email stays multi-paragraph.
- Keep within roughly the same length — don't pad, don't compress beyond ±20%.

## Tone targets

- **Greet like a person, not a bot.** "Hey Sam," not "Dear Mr. Sam," and not "👋 Hey there!".
- **First-person warmth**: "I appreciate", "I'd love to", "happy to". Avoid corporate plural ("we are pleased to inform you").
- **Soft directness**: questions over commands, "could you" over "please ensure".
- **Light, situational closers**: "Speak soon", "Thanks again" — match the relationship implied by the source.
- **Avoid:** exclamation stacks, emoji unless they were already in the source, "I hope this email finds you well", "circle back", "synergy", and other corporate filler.

## When the input is ambiguous

If the user wrote `/rephrase-friendly` with no body, ask once: "What text would you like in a friendlier tone?"

If the input contains structural elements that don't translate (bullet lists in a chat fragment, headings inside a one-line message), keep them only if they survived the original — never invent new structure.
