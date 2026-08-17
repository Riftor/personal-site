---
title: This website
kind: project
min_tier: public
status: published
occurred_on: 2026-08-14
summary: A personal site with two halves — a public portfolio, and a private one where every visitor sees exactly the slice I gave them and nothing beyond it.
---

The public half is a portfolio. The private half holds photos, memories and a calendar, and
the whole design question was the word _private_: not "hidden behind a login", but private
in the sense that there is no request you can construct, signed in or not, that returns
something you weren't granted.

That turned out to be mostly a story about defaults. Access is graded — friend, family,
partner — and every one of them is a floor, never a guess: an entry with a missing tier is
readable by nobody rather than everybody, and an unrecognised value stops the publish
instead of picking an audience. A photo's URL is not a key to that photo; the tier is
re-checked on every request for it, including the ones a browser makes on its own to ask
whether its copy is still good.

The failures I care most about are the quiet ones. A page rendered ahead of time would be
served by the edge before any of that code runs — correct-looking, and readable by anyone
who guesses the address — so the build fails rather than let one through. Signed-out and
not-allowed are answered differently on purpose, and a real photo and an invented one come
back byte-for-byte identical, so no response can be used to find out what exists.

Four rounds of adversarial review found four real bugs, none of which my own passing tests
had noticed. That ratio is the part of this project I'd repeat.

Built with SvelteKit on Cloudflare Workers, D1 and R2. The code is public; the contents
are not.
