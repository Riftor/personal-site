---
title: Archer Aviation — Data Science Intern
kind: project
min_tier: public
status: published
occurred_on: 2026-08-01
summary: A summer building telemetry into the internal Python tooling used by 100+ engineers — and making the measuring invisible to the people being measured.
---

Archer builds electric aircraft; I worked on the ground, in the internal tooling their
engineers live in. The task was user telemetry for an enterprise-grade internal Python
package: knowing which tools get used, how, and by whom, so the team maintaining them
could stop guessing.

The design constraint that shaped everything was _zero friction_. Telemetry that asks
engineers to opt in, configure something, or tolerate latency gets turned off. Collection
had to ride along invisibly — no setup, no perceptible cost — for over a hundred
engineers.

The pipeline ran end to end on Snowflake's serverless ingestion and tasks: collection,
storage, and analysis with effectively no infrastructure to babysit and near-zero cost.
The part that made it stick wasn't technical — I partnered with the owners of each
internal tool to roll the update out inside their own workflows, so adoption happened
without anyone taking on new overhead.

Along the way I built Claude Skills automating the repetitive parts of engineering
workflows — the kind of ten-minute tasks that recur forever — saving engineers an
estimated 10–20 hours a week between them.
