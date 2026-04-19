"""Test MCP server that reports environment variable state and CWD."""

import os
from fastmcp import FastMCP

mcp = FastMCP("test-mcp")


@mcp.tool()
def get_server_info() -> dict:
    """Report all environment variables and the current working directory of the server."""
    return {
        "env": dict(os.environ),
        "cwd": os.getcwd(),
    }


if __name__ == "__main__":
    mcp.run()
