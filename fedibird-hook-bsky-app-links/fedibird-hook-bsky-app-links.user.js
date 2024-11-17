// ==UserScript==
// @name        fedibird.com - Hook bsky.app links
// @namespace   https://github.com/tesaguri
// @match       https://fedibird.com/web/*
// @grant       none
// @version     1.0.0
// @updateURL   https://github.com/tesaguri/userscripts/raw/main/fedibird-hook-bsky-app-links/fedibird-hook-bsky-app-links.user.js
// @author      Daiki "tesaguri" Mizukami
// @license     GPL-3.0-only; https://www.gnu.org/licenses/gpl-3.0.txt
// @description Open bsky.app links via Bridgy Fed or PDS
// ==/UserScript==

(() => {
    // INIT

    let searchInput = document.getElementsByClassName('search__input')[0];
    if (!searchInput) {
        function searchForSearchInput(records, observer) {
            for (const { addedNodes } of records) {
                for (const node of addedNodes) {
                    searchInput = node.getElementsByClassName('search__input')[0];
                    if (searchInput) {
                        observer.disconnect();
                        return;
                    }
                }
            }
        }
        new MutationObserver(searchForSearchInput)
            .observe(document.body, {
                childList: true,
                subtree: true,
            });
    }

    const columnsArea = document.getElementsByClassName('columns-area')[0];
    if (columnsArea) {
        new MutationObserver(observeNewColumns)
            .observe(columnsArea, {
                childList: true,
            });
    } else {
        function searchForColumnsArea(records, observer) {
            for (const { addedNodes } of records) {
                for (const node of addedNodes) {
                    if (node.classList?.contains('columns-area')) {
                        new MutationObserver(observeNewColumns)
                            .observe(node, {
                                childList: true,
                            });
                        observer.disconnect();
                    }
                }
            }
        }
        new MutationObserver(searchForColumnsArea)
            .observe(document.body, {
                childList: true,
                subtree: true,
            });
    }

    const feedObserver = new MutationObserver(observeNewArticles);
    function observeNewColumns(records, _observer) {
        for (const { addedNodes } of records) {
            for (const node of addedNodes) {
                if (node.classList?.contains('column')) {
                    const feed = node.querySelector('.item-list[role="feed"]');
                    if (feed) {
                        feedObserver.observe(feed, {
                            childList: true,
                        });
                    } else if (node instanceof Element) {
                        hookDescendantBskyLinks(node);
                    }
                }
            }
        }
    }

    function observeNewArticles(records, _observer) {
        for (const { addedNodes } of records) {
            for (const node of addedNodes) {
                if (node instanceof Element) {
                    hookDescendantBskyLinks(node);
                }
            }
        }
    }

    const acceptAs2Headers = new Headers([['accept', 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"']]);
    function hookDescendantBskyLinks(elt) {
        for (const anchor of elt.querySelectorAll('a.unhandled-link:not(.status-url-link)[href^="https://bsky.app/profile/"]')) {
            const components = atComponentsFromBskyUrl(anchor.href);
            if (!components) {
                continue;
            }
            let authority = components[0];
            const collection = components[1];
            const rkey = components[2];
            if (collection === undefined || collection === 'app.bsky.feed.post') {
                let bridgeUrl = bridgeUrlFromComponents(authority, collection, rkey);
                let verifiedBridge;
                anchor.addEventListener('click', e => {
                    e.preventDefault();
                    if (verifiedBridge) {
                        submitSearch(bridgeUrl);
                        return;
                    }
                    fetch(bridgeUrl, {
                        method: 'HEAD',
                        headers: acceptAs2Headers,
                        referrer: '',
                    })
                        .then(async res => {
                            if (res.ok) {
                                verifiedBridge = true;
                                return submitSearch(bridgeUrl);
                            }
                            if (!authority.startsWith('did:')) {
                                authority = await resolveAtHandle(authority);
                                bridgeUrl = bridgeUrlFromComponents(authority, collection, rkey);
                            }
                            open(await pdsXrpcUrlForComponents(authority, collection, rkey));
                        });
                });
            } else {
                anchor.addEventListener('click', e => {
                    e.preventDefault();
                    pdsXrpcUrlForComponents(authority, collection, rkey)
                        .then(open);
                });
            }
        }
    }

    // UTILITIES - Fedibird

    function submitSearch(query) {
        if (!searchInput) return;
        searchInput.focus();
        // <https://hustle.bizongo.in/simulate-react-on-change-on-controlled-components-baa336920e04>
        const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setValue.call(searchInput, query);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        // FIXME: Doesn't work
        searchInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
    }

    // UTILITIES - AT Protocol

    const acceptDnsJsonHeaders = new Headers([['accept', 'application/dns-json']]);
    async function resolveAtHandle(handle) {
        try {
            const res = await fetch(`https://cloudflare-dns.com/dns-query?name=_atproto.${handle}&type=TXT`, {
                headers: acceptDnsJsonHeaders,
                referrer: '',
            });
            if (res.ok) {
                const json = await res.json();
                const expectedName = `_atproto.${handle}`;
                for (const answer of json?.Answer ?? []) {
                    if (answer.name === expectedName && answer.type === 16 && answer.data?.startsWith('"did=') && answer.data.endsWith('"')) {
                        return answer.data.slice(5, -1);
                    }
                }
            }
        } catch {
            // Fall back on well-known
        }
        try {
            const res = await fetch(`https://${handle}/.well-known/atproto-did`, {
                method: 'HEAD',
                referrer: '',
            });
            if (res.ok) {
                return await res.text().trim();
            }
        } catch {
            // noop
        }
    }

    function pdsFromDidDoc(doc) {
        for (const service of asArray(doc.service)) {
            if (asArray(service.type).includes('AtprotoPersonalDataServer')) {
                return service.serviceEndpoint;
            }
        }
    }

    const acceptDidHeaders = new Headers([['accept', 'application/did+ld+json']]);
    async function resolveDid(did) {
        let url;
        if (did.startsWith('did:plc:')) {
            url = `https://plc.directory/${did}`;
        } else if (did.startsWith('did:web:')) {
            url = `https://${did.split(8)}/.well-known/did.json`;
        } else {
            throw new Error(`Unrecognized DID: ${did}`);
        }

        const res = await fetch(url, {
            headers: acceptDidHeaders,
            referrer: '',
        });

        if (!res.ok) {
            throw new Error(`Encountered HTTP ${res.status} status while resolving DID ${did}`);
        }

        return await res.json();
    }

    function asArray(value) {
        if (value instanceof Array) {
            return value;
        } else if (value === null || value === undefined) {
            return [];
        } else {
            return [value];
        }
    }

    async function pdsXrpcUrlForComponents(did, collection, rkey) {
        const pds = pdsFromDidDoc(await resolveDid(did));
        return rkey === undefined
            ? `${pds}/xrpc/com.atproto.repo.describeRepo?repo=${did}`
            : `${pds}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${collection}&rkey=${rkey}`;
    }

    function bridgeUrlFromComponents(authority, collection, rkey) {
        const at = rkey === undefined ? `at://${authority}` : `at://${authority}/${collection}/${rkey}`;
        return `https://bsky.brid.gy/convert/ap/${at}`;
    }

    // UTILITIES - Bluesky

    function atComponentsFromBskyUrl(url) {
        const segments = url.split('/');
        const authority = segments[4];
        if (authority === undefined) {
            return;
        }
        const collection = segments[5];
        if (collection === undefined) {
            return [authority];
        }
        const rkey = segments[6];
        if (rkey !== undefined) {
            switch (collection) {
                case 'post':
                    return [authority, 'app.bsky.feed.post', rkey];
                case 'feed':
                    return [authority, 'app.bsky.feed.generator', rkey];
            }
        }
    }
})();
