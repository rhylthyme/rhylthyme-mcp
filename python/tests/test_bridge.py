"""Argument handling offline; the bridge itself against the hosted server
when RHYLTHYME_MCP_LIVE=1 (it is a pass-through, so that is the only honest
test of it)."""

import os
import sys

import pytest

from rhylthyme_mcp import server


def test_endpoint_selection(monkeypatch):
    monkeypatch.delenv("RHYLTHYME_MCP_URL", raising=False)
    assert server.endpoint(None, None) == "https://mcp.rhylthyme.com/mcp"
    assert server.endpoint("generic", None) == "https://mcp.rhylthyme.com/mcp"
    assert server.endpoint("lab", None) == "https://mcp.rhylthyme.com/lab/mcp"
    assert server.endpoint("gym", "http://localhost:3000/mcp/") == "http://localhost:3000/gym/mcp"
    # An explicit vertical URL is left alone.
    assert server.endpoint("lab", "https://mcp.rhylthyme.com/kitchen/mcp") == "https://mcp.rhylthyme.com/kitchen/mcp"
    monkeypatch.setenv("RHYLTHYME_MCP_URL", "https://example.test/mcp")
    assert server.endpoint("events", None) == "https://example.test/events/mcp"


def test_help_and_version_exit_without_touching_the_network(capsys):
    for flag in ("--help", "--version"):
        with pytest.raises(SystemExit) as stop:
            server.main([flag])
        assert stop.value.code == 0
    out = capsys.readouterr().out
    assert "https://mcp.rhylthyme.com/mcp" in out and "rhylthyme-mcp 0.1.1" in out


def test_unreachable_server_fails_on_stderr_not_stdout(capsys):
    with pytest.raises(SystemExit) as stop:
        server.main(["--url", "http://127.0.0.1:9/mcp"])
    assert stop.value.code == 1
    captured = capsys.readouterr()
    assert captured.out == "", "stdout is the protocol channel"
    assert "could not bridge" in captured.err and "mcp.rhylthyme.com" in captured.err


@pytest.mark.skipif(not os.environ.get("RHYLTHYME_MCP_LIVE"), reason="set RHYLTHYME_MCP_LIVE=1 to bridge to the hosted server")
def test_bridge_passes_tools_resources_prompts_and_calls_through():
    import anyio
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def go():
        # stdio_client starts the child with a minimal environment; hand it
        # ours so an uninstalled checkout (PYTHONPATH=src) is importable.
        params = StdioServerParameters(
            command=sys.executable, args=["-m", "rhylthyme_mcp.server", "kitchen"], env=dict(os.environ)
        )
        # pytest replaces sys.stderr with an object that has no fileno().
        async with stdio_client(params, errlog=open(os.devnull, "w")) as (read, write):
            async with ClientSession(read, write) as session:
                hello = await session.initialize()
                assert "validate_program" in (hello.instructions or "")
                names = {t.name for t in (await session.list_tools()).tools}
                assert {"validate_program", "analyze_schedule", "visualize_schedule", "cook_recipe"} <= names
                uris = {str(r.uri) for r in (await session.list_resources()).resources}
                assert "rhylthyme://guide/authoring" in uris
                guide = await session.read_resource("rhylthyme://guide/authoring")
                assert guide.contents and guide.contents[0].text
                assert (await session.list_prompts()).prompts
                bad = await session.call_tool("validate_program", {"program": {"programId": "x", "name": "x", "tracks": []}})
                assert bad.structuredContent["valid"] is False
                assert bad.structuredContent["errors"][0]["code"] == "no_tracks"

    anyio.run(go)
