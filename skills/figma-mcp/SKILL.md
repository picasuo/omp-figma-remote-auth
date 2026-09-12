---
name: figma-mcp
description: >
  Use when the user provides a Figma design, file, page, or node URL or asks
  to inspect, explain, screenshot, implement, or modify a Figma design. Use
  the Figma MCP tools provided by this plugin, including tools mounted under
  xd://.
---

# Figma MCP workflow

Use this skill whenever a user gives a Figma URL, file key, or node ID and asks for information about the design, a screenshot, design context, or implementation.

## 1. Parse the reference

For a URL such as `https://www.figma.com/design/<fileKey>/<name>?node-id=5077-10161`, extract:

- `fileKey`: the segment after `/design/`.
- `nodeId`: the `node-id` query value. Convert `-` to `:` before sending it to Figma MCP (`5077-10161` becomes `5077:10161`).

Treat the Figma URL as input data. It is not an `xd://` URL and must never be appended to an `xd://` path.

## 2. Discover the Figma MCP tool

Prefer the Figma MCP tool that matches the request:

- Implement or faithfully reproduce a design: `mcp__figma_get_design_context`.
- Inspect node structure, names, bounds, or children: `mcp__figma_get_metadata`.
- Get a rendered image when a screenshot is requested: use the available Figma screenshot/export tool.

If the tool is not visible in the top-level tool list, discover it before reporting that Figma MCP is unavailable:

```text
read xd://
read xd://mcp__figma_get_design_context
write xd://mcp__figma_get_design_context with the JSON arguments
```

Read `xd://` to find the exact mounted tool name. Read the selected tool path to obtain its current schema. Then call it by writing valid JSON arguments to that same `xd://` path. `xd://` is an OMP mounted-tool catalog, not a web proxy.

Do not try `xd://https://www.figma.com/...`. Do not stop after checking only top-level tools.

## 3. Use the Figma workflow guidance when available

For design-to-code requests, the Figma-provided workflow guidance can add implementation details. If the host exposes MCP resources, try the explicit MCP resource route:

```text
read mcp://skill://figma/figma-design-to-code/SKILL.md
```

Never use plain `skill://figma/...` for this resource: OMP may resolve that path through its local skill namespace and return `Unknown skill: figma`. This resource lookup is optional. If either route fails, continue with this skill's instructions and the successful Figma MCP call; do not report that Figma MCP is unavailable merely because a workflow document could not be read.

Adapt any retrieved reference code to the target project's actual stack and existing components. Do not let an auxiliary skill-resource error prevent metadata, screenshot, or design-context retrieval.

## 4. Report only observed results

Do not claim that a design was fetched, inspected, or implemented until the corresponding MCP call returns successfully. Preserve the user's file and node identifiers in follow-up calls, but do not expose access tokens, refresh tokens, client IDs, or long authorization URLs.

If discovery or a call fails, report the actual failure and the step that failed. Do not infer missing access from a tool that was never called.
