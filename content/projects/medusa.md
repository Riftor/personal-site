---
title: Medusa — UAS/UGV Ground Station
kind: project
min_tier: public
status: published
occurred_on: 2025-05-01
summary: Real-time flight telemetry for Purdue Aerial Robotics' SUAS competition entry — from onboard radio to live dashboards on the ground.
---

Purdue Aerial Robotics' entry to the SUAS competition paired an autonomous aircraft with
a ground vehicle, and somebody had to make the aircraft legible from the ground. I built
the telemetry path: receiving data from onboard transmission and moving it through
RabbitMQ into Django's ORM, with Grafana on top showing altitude, velocity, waypoint
tracking and the rest of the flight picture live, as it happened.

The other half was making the software testable without risking the airframe. I set up
ArduPilot's SITL — software-in-the-loop flight simulation — on Linux, so navigation and
flight software could fly full waypoint missions on a desk. Crashing a simulated plane
costs nothing, and we did it often, on purpose.
