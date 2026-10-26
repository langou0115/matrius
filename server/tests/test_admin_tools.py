from app.admin import router as admin_router_module


async def test_admin_can_test_web_search(client, create_user, monkeypatch):
    calls = []

    async def fake_search(query, limit, *, trace=None):
        calls.append((query, limit))
        if trace is not None:
            trace.update({"provider": "duckduckgo", "status": "ok", "attempts": 1,
                          "elapsedMs": 12, "fallback": False, "fallbackStatus": None})
        return [{
            "title": "Example",
            "url": "https://example.com/page",
            "snippet": "Snippet",
            "domain": "example.com",
            "engine": "duckduckgo",
            "rank": 1,
        }]

    monkeypatch.setattr(admin_router_module, "web_search", fake_search)
    _, headers = await create_user(username="root", is_admin=True)

    response = await client.post(
        "/api/admin/tools/test",
        json={"kind": "search", "query": "  python docs  "},
        headers=headers,
    )

    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result["kind"] == "search"
    assert result["query"] == "python docs"
    assert result["results"][0]["url"] == "https://example.com/page"
    assert result["tookMs"] >= 0
    assert result["proxy"] is False
    assert result["diagnostics"] == {
        "provider": "duckduckgo", "status": "ok", "attempts": 1,
        "elapsedMs": 12, "fallback": False, "fallbackStatus": None,
    }
    assert calls == [("python docs", 8)]


async def test_admin_can_test_web_fetch(client, create_user, monkeypatch):
    calls = []

    async def fake_fetch(url, mode, *, trace=None):
        calls.append((url, mode))
        if trace is not None:
            trace.update({"attempts": 1, "contentType": "text/html",
                          "finalUrl": url, "truncated": False, "extractor": "trafilatura"})
        return {
            "title": "Example page",
            "url": "https://example.com/page",
            "text": "Readable body",
            "truncated": False,
            "chars": len("Readable body"),
        }

    monkeypatch.setattr(admin_router_module, "web_fetch", fake_fetch)
    _, headers = await create_user(username="root", is_admin=True)

    response = await client.post(
        "/api/admin/tools/test",
        json={"kind": "fetch", "url": " https://example.com/page ", "mode": "full"},
        headers=headers,
    )

    assert response.status_code == 200, response.text
    result = response.json()["result"]
    assert result == {
        "kind": "fetch",
        "tookMs": result["tookMs"],
        "proxy": False,
        "diagnostics": {
            "attempts": 1, "contentType": "text/html",
            "finalUrl": "https://example.com/page", "truncated": False, "extractor": "trafilatura",
        },
        "title": "Example page",
        "url": "https://example.com/page",
        "text": "Readable body",
        "truncated": False,
        "chars": 13,
    }
    assert calls == [("https://example.com/page", "full")]


async def test_tool_test_requires_an_admin_session(client, create_user):
    _, headers = await create_user(username="alice", is_admin=False)
    response = await client.post(
        "/api/admin/tools/test",
        json={"kind": "search", "query": "python"},
        headers=headers,
    )
    assert response.status_code == 403


async def test_tool_test_validates_the_required_field(client, create_user):
    _, headers = await create_user(username="root", is_admin=True)

    search = await client.post(
        "/api/admin/tools/test",
        json={"kind": "search", "query": "   "},
        headers=headers,
    )
    fetch = await client.post(
        "/api/admin/tools/test",
        json={"kind": "fetch", "url": ""},
        headers=headers,
    )

    assert search.status_code == 422
    assert search.json()["error"]["code"] == "invalid"
    assert fetch.status_code == 422
    assert fetch.json()["error"]["code"] == "invalid"
