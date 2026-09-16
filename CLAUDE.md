# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Setup guides and documentation for deploying claw servers (OpenClaw, NVIDIA NemoClaw) and connecting them to the ibl.ai platform. This is a documentation repo, not an application codebase.

## Repository Structure

- `README.md` -- Visual landing page (follows iblai-infra-cli format with centered logo, badges)
- `docs/server-setup.md` -- Full guide: install OpenClaw, configure Caddy for TLS, systemd service, firewall, monitoring
- `docs/platform-integration.md` -- Full guide: register instance via API, bind mentors, configure agents, manage skills, push config
- `docs/nemoclaw-setup.md` -- NemoClaw on a public VPS with root
- `docs/nemoclaw-restricted-host.md` -- NemoClaw on a host without root, proxy-only egress, inbound through an existing TLS endpoint, model access through a host relay
- `scripts/inference-relay.cjs` -- Host relay used by the restricted-host guide

## Two Core Components

1. **Server Setup** (docs/server-setup.md): Deploy OpenClaw gateway on a VPS with Caddy reverse proxy and TLS
2. **Platform Integration** (docs/platform-integration.md): Connect to ibl.ai via REST API -- register instances, configure mentors/agents/skills, push config. Once connected, the claw instance is accessible from all ibl.ai applications (Mentor AI, Skills AI, custom integrations).

## Key Technical Details

- All ibl.ai API endpoints are under `/api/ai-mentor/orgs/<org>/`
- Caddy must run on the host (not Docker) to preserve loopback auto-approval for device identity
- OpenClaw gateway binds to loopback only (port 18789), Caddy handles TLS termination
- Device identity uses Ed25519 signing on WebSocket connect
- Agent config fields (identity, soul, user_context, etc.) map to workspace markdown files (IDENTITY.md, SOUL.md, USER.md, etc.)
