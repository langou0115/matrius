import asyncio
import ipaddress
import socket
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from app.errors import invalid

TRACKING_PARAMS = {"fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref_src", "msclkid"}
BLOCKED_HOST_SUFFIXES = (".local", ".localhost", ".internal", ".home.arpa")
BLOCKED_HOSTS = {"localhost", "host.docker.internal", "metadata.google.internal"}


def _is_tracking(name: str) -> bool:
    lowered = name.lower()
    return lowered.startswith("utm_") or lowered in TRACKING_PARAMS


def normalize_search_url(raw: str) -> str | None:
    """Return a clean http(s) URL or None for non-web / malformed results."""
    try:
        parts = urlsplit(raw.strip())
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    if parts.username or parts.password:
        return None
    filtered = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if not _is_tracking(key)]
    return urlunsplit(
        (
            parts.scheme,
            parts.netloc.lower(),
            parts.path or "/",
            urlencode(filtered, doseq=True),
            "",
        )
    )


def canonical_result_key(url: str) -> str:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().removeprefix("www.")
    path = parts.path
    if path == "/":
        path = "/"
    else:
        path = path.rstrip("/")
    query = sorted(parse_qsl(parts.query, keep_blank_values=True))
    return f"{host}{path}?{urlencode(query)}" if query else f"{host}{path}"


def _address_is_public(raw: str) -> bool:
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        return False
    return address.is_global and not address.is_multicast


def _validate_hostname(hostname: str) -> None:
    host = hostname.lower().strip("[]")
    if host in BLOCKED_HOSTS or any(host.endswith(suffix) for suffix in BLOCKED_HOST_SUFFIXES):
        raise invalid("出于安全原因，不能读取本机或内网地址。")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        return
    if not _address_is_public(str(literal)):
        raise invalid("出于安全原因，不能读取本机或内网地址。")


async def _resolve(hostname: str, port: int) -> list[str]:
    try:
        infos = await asyncio.wait_for(
            asyncio.to_thread(socket.getaddrinfo, hostname, port, type=socket.SOCK_STREAM),
            timeout=5,
        )
    except (TimeoutError, socket.gaierror):  # type: ignore[arg-type]
        raise invalid("无法解析该网页地址。") from None
    return [info[4][0] for info in infos]


async def validate_fetch_url(raw: str) -> str:
    try:
        parts = urlsplit(raw.strip())
    except ValueError as exc:
        raise invalid("网页地址不合法。") from exc
    if parts.scheme not in ("http", "https"):
        raise invalid("网页地址必须是有效的 http 或 https 地址。")
    if parts.username or parts.password:
        raise invalid("网页地址不能包含用户名或密码。")
    if not parts.hostname:
        raise invalid("网页地址不合法。")

    _validate_hostname(parts.hostname)
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise invalid("网页地址不合法。") from exc

    literal_host = parts.hostname.strip("[]")
    try:
        ipaddress.ip_address(literal_host)
        addresses = [literal_host]
    except ValueError:
        addresses = await _resolve(parts.hostname, port)

    if not addresses:
        raise invalid("无法解析该网页地址。")
    for address in addresses:
        if not _address_is_public(address):
            raise invalid("出于安全原因，不能读取本机或内网地址。")

    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))


__all__ = [
    "canonical_result_key",
    "normalize_search_url",
    "validate_fetch_url",
]
