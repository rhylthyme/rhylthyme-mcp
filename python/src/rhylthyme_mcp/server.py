"""rhylthyme-mcp: a stdio MCP server that forwards to the hosted one.

The Rhylthyme MCP server is hosted at https://mcp.rhylthyme.com/mcp
(Streamable HTTP). A client that can connect to a URL should use that
directly. This command exists for clients that can only launch a process: it
speaks MCP on stdin/stdout and passes every request (tools, resources,
prompts) through to the hosted server, so the tool list is always the current
one and nothing is implemented twice.

    rhylthyme-mcp                 # general endpoint
    rhylthyme-mcp kitchen         # or lab, events, gym
    rhylthyme-mcp --url http://localhost:3000/mcp

Environment: RHYLTHYME_MCP_URL (same as --url), RHYLTHYME_TOKEN (an access
token, sent as a bearer header; only the account tools need one).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any, AsyncIterator, Dict, List, Optional, Tuple

from . import __version__

DEFAULT_URL = "https://mcp.rhylthyme.com/mcp"
VERTICALS = ("kitchen", "lab", "events", "gym")
# import_text runs four model turns on the server.
CALL_TIMEOUT = timedelta(seconds=300)


def endpoint(vertical: Optional[str], url: Optional[str]) -> str:
    base = (url or os.environ.get("RHYLTHYME_MCP_URL") or DEFAULT_URL).rstrip("/")
    if vertical and vertical != "generic" and base.endswith("/mcp"):
        head = base[: -len("/mcp")]
        if head.rsplit("/", 1)[-1] not in VERTICALS:
            return f"{head}/{vertical}/mcp"
    return base


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="rhylthyme-mcp",
        description=(
            "Stdio bridge to the hosted Rhylthyme MCP server. If your client can "
            f"connect to a URL, skip this and use {DEFAULT_URL} directly."
        ),
        epilog="Docs: https://docs.rhylthyme.com/web-app/mcp/",
    )
    parser.add_argument(
        "vertical",
        nargs="?",
        default="generic",
        choices=("generic",) + VERTICALS,
        help="which endpoint to bridge to (default: generic)",
    )
    parser.add_argument("--url", help=f"MCP endpoint (default: {DEFAULT_URL})")
    parser.add_argument("--version", action="version", version=f"rhylthyme-mcp {__version__}")
    return parser.parse_args(argv)


@asynccontextmanager
async def connect(url: str, headers: Dict[str, str]) -> AsyncIterator[Tuple[Any, Any]]:
    """The hosted server's read and write streams.

    The SDK's HTTP client changed twice: `streamablehttp_client(url, headers=)`
    up to 1.2x, then `streamable_http_client(url, http_client=)`, on httpx in
    1.x and httpx2 in 2.x. All three are supported."""
    from mcp.client import streamable_http

    seconds = CALL_TIMEOUT.total_seconds()
    modern = getattr(streamable_http, "streamable_http_client", None)
    if modern is None:
        async with streamable_http.streamablehttp_client(
            url, headers=headers, sse_read_timeout=CALL_TIMEOUT
        ) as streams:
            yield streams[0], streams[1]
        return
    try:
        import httpx2 as hx
    except ImportError:
        import httpx as hx  # type: ignore[no-redef]
    http = streamable_http.create_mcp_http_client(
        headers=headers, timeout=hx.Timeout(30, read=seconds)
    )
    async with http:
        async with modern(url, http_client=http) as streams:
            yield streams[0], streams[1]


def _server_info(hello: Any) -> Tuple[str, str]:
    info = getattr(hello, "server_info", None) or getattr(hello, "serverInfo", None)
    return (getattr(info, "name", None) or "rhylthyme", getattr(info, "version", None) or "")


def _server_v2(server_cls: Any, hello: Any, upstream: Any) -> Any:
    """SDK 2.x: handlers are constructor callbacks taking (context, params)."""
    seconds = CALL_TIMEOUT.total_seconds()

    async def list_tools(_ctx: Any, params: Any) -> Any:
        return await upstream.list_tools(params=params)

    async def call_tool(_ctx: Any, params: Any) -> Any:
        return await upstream.call_tool(
            params.name, params.arguments or {}, read_timeout_seconds=seconds
        )

    async def list_resources(_ctx: Any, params: Any) -> Any:
        return await upstream.list_resources(params=params)

    async def read_resource(_ctx: Any, params: Any) -> Any:
        return await upstream.read_resource(str(params.uri))

    async def list_prompts(_ctx: Any, params: Any) -> Any:
        return await upstream.list_prompts(params=params)

    async def get_prompt(_ctx: Any, params: Any) -> Any:
        return await upstream.get_prompt(params.name, params.arguments)

    name, version = _server_info(hello)
    handlers: Dict[str, Any] = {"on_list_tools": list_tools, "on_call_tool": call_tool}
    if hello.capabilities.resources is not None:
        handlers.update(on_list_resources=list_resources, on_read_resource=read_resource)
    if hello.capabilities.prompts is not None:
        handlers.update(on_list_prompts=list_prompts, on_get_prompt=get_prompt)
    return server_cls(name, version=version, instructions=hello.instructions, **handlers)


def _server_v1(server_cls: Any, hello: Any, upstream: Any) -> Any:
    """SDK 1.x. Registered on request_handlers rather than through the
    decorators: the decorators re-validate arguments and results against
    cached schemas, and a bridge must pass both through exactly as the hosted
    server sent them."""
    import mcp.types as types

    name, version = _server_info(hello)
    server = server_cls(name, version=version or None, instructions=hello.instructions)

    def cursor(req: Any) -> Optional[str]:
        return req.params.cursor if req.params else None

    async def list_tools(req: Any) -> Any:
        return types.ServerResult(await upstream.list_tools(cursor=cursor(req)))

    async def call_tool(req: Any) -> Any:
        result = await upstream.call_tool(
            req.params.name, req.params.arguments or {}, read_timeout_seconds=CALL_TIMEOUT
        )
        return types.ServerResult(result)

    async def list_resources(req: Any) -> Any:
        return types.ServerResult(await upstream.list_resources(cursor=cursor(req)))

    async def read_resource(req: Any) -> Any:
        return types.ServerResult(await upstream.read_resource(req.params.uri))

    async def list_prompts(req: Any) -> Any:
        return types.ServerResult(await upstream.list_prompts(cursor=cursor(req)))

    async def get_prompt(req: Any) -> Any:
        return types.ServerResult(await upstream.get_prompt(req.params.name, req.params.arguments))

    server.request_handlers[types.ListToolsRequest] = list_tools
    server.request_handlers[types.CallToolRequest] = call_tool
    if hello.capabilities.resources is not None:
        server.request_handlers[types.ListResourcesRequest] = list_resources
        server.request_handlers[types.ReadResourceRequest] = read_resource
    if hello.capabilities.prompts is not None:
        server.request_handlers[types.ListPromptsRequest] = list_prompts
        server.request_handlers[types.GetPromptRequest] = get_prompt
    return server


async def bridge(url: str, headers: Dict[str, str]) -> None:
    import inspect

    from mcp.client.session import ClientSession
    from mcp.server.lowlevel import Server
    from mcp.server.stdio import stdio_server

    async with connect(url, headers) as (read, write):
        async with ClientSession(read, write) as upstream:
            hello = await upstream.initialize()
            callbacks = "on_call_tool" in inspect.signature(Server.__init__).parameters
            build = _server_v2 if callbacks else _server_v1
            server = build(Server, hello, upstream)
            async with stdio_server() as (stdin, stdout):
                await server.run(stdin, stdout, server.create_initialization_options())


def main(argv: Optional[List[str]] = None) -> None:
    args = parse_args(argv)
    url = endpoint(args.vertical, args.url)
    headers = {"User-Agent": f"rhylthyme-mcp-bridge/{__version__}"}
    token = os.environ.get("RHYLTHYME_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        asyncio.run(bridge(url, headers))
    except KeyboardInterrupt:
        pass
    except BaseException as exc:  # noqa: BLE001 - includes exception groups
        if isinstance(exc, SystemExit):
            raise
        # stdout belongs to the protocol; say what went wrong on stderr.
        print(f"rhylthyme-mcp: could not bridge to {url}: {exc!r}", file=sys.stderr)
        print(
            "If your client can connect to a URL, use it directly: " + DEFAULT_URL,
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
