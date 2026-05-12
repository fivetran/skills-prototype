---
name: test-skill
description: A simple test skill for experimenting with plugin installation flows. Reports server environment state.
compatibility:
  tools:
    - test-mcp:get_server_info
metadata:
  short-description: Test skill that reports MCP server environment info
---

# Test Skill

Use the `get_server_info` tool from the `test-mcp` MCP server to report:
- The value of `TEST_ENV_VARIABLE`
- The current working directory of the MCP server process

This skill is used for testing plugin installation and MCP server configuration flows.
