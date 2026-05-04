---
name: rephrase-clear
description: Rephrase the user's text in plain language — short sentences, common words, one idea per clause. Aimed at non-specialist or ESL readers. Triggers on "/rephrase-clear", "make this clearer", "explain this in plain English", or pasted text after the slash command.
argument_hint: "[text to rephrase]"
---

# Rephrase · clear

Rewrite the text the user supplies (after the `/rephrase-clear` command, or quoted in the conversation) into **plain, easy-to-read language**. The output should be understandable to a non-specialist or ESL reader without losing precision.

## Output rules

- Return only the rephrased text. No preamble ("Here's…"), no commentary, no diff.
- Preserve **every fact, named entity, number, code reference, and URL** verbatim.
- Match the original **language**.
- Match the original **format**.
- Length may grow by up to ~20% if a single jargon term needs a short gloss; otherwise stay within ±10%.

## Tone targets

- **Short sentences.** Aim for ≤20 words per sentence; break long ones into two.
- **Common words first.** "use" not "utilize", "help" not "facilitate", "show" not "demonstrate".
- **One idea per clause.** Strip nested parentheticals; if a sub-clause adds important detail, give it its own sentence.
- **Active voice.** "The team approved the plan" — not "The plan was approved by the team".
- **Define jargon inline** the first time it appears: "the API (the system that lets two programs talk to each other) returns…". Only gloss terms that a non-specialist wouldn't know.
- **Concrete over abstract.** "We sent the report on Monday" beats "Communication was effected at the start of the week".
- **Avoid:** triple-stacked nouns ("user data retention compliance review"), Latinate adverbs ("notwithstanding", "henceforth"), and idioms that don't translate ("ballpark figure", "moving the needle").

## When the input is ambiguous

If the user wrote `/rephrase-clear` with no body, ask once: "What text would you like in plainer language?"

If the source text is heavily technical and a faithful plain-language version would lose accuracy (e.g. legal clauses, contract language), warn once with a one-line note before rewriting: "Plain-language version — for the binding text, refer to the original."
