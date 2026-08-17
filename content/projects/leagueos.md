---
title: LeagueOS — Data Science Intern
kind: project
min_tier: public
status: published
occurred_on: 2024-08-01
summary: Instrumenting a sports platform end to end — collecting user interaction data in the frontend and turning it into dashboards people checked.
---

LeagueOS (Spectator Sports) runs software for sports leagues, and wanted to actually see
how people used it. I built the instrumentation into the React/TypeScript frontend —
collecting and tracking user interaction data with attention to it being right, because
interaction data that's silently wrong is worse than none.

Downstream, I parsed and cleaned that data into MongoDB and PostgreSQL, then designed
interactive dashboards visualizing user activity across time ranges — daily spikes,
seasonal patterns, the shape of how the product was really used. First time seeing the
full arc from a click in a browser to a chart a decision gets made from; I've been
partial to owning the whole pipeline ever since.
