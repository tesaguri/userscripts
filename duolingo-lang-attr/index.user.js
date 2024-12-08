// ==UserScript==
// @name        Duolingo - Insert `lang` attribute
// @namespace   https://github.com/tesaguri
// @match       https://*.duolingo.com/*
// @grant       none
// @version     1.0.0
// @updateURL   https://github.com/tesaguri/userscripts/raw/main/index.user.js
// @author      Daiki "tesaguri" Mizukami
// @license     GPL-3.0-only; http://www.gnu.org/licenses/gpl-3.0.txt
// @description Inserts appropriate `lang` attributes to Duolingo's texts.
// ==/UserScript==

(() => {
    const observer = new MutationObserver(mutations => {
        const duolang = location.pathname.match(/^\/(?:skill|placement)\/([^\/]+)/)?.[1];
        if (!duolang) {
            return;
        }
        const lang = ({
            dn: 'nl', // Dutch
            hv: 'art-x-valyrian', // High Valyrian
            hw: 'haw', // Hawaiian
            kl: 'tlh', // Klingon
            zs: 'zh', // Chinese
        })[duolang] || duolang;

        for (const mutation of mutations) {
            for (const n of mutation.addedNodes) {
                if (n instanceof Element) {
                    for (const elt of n.querySelectorAll('[data-test="hint-sentence"], [data-test="hint-token"], [data-test="hint-popover"] thead')) {
                        if (elt instanceof HTMLElement) {
                            elt.lang = lang;
                        }
                    }
                }
            }
        }
    });

    const root = document.getElementById('root');
    if (root) {
        observer.observe(root, { childList: true, subtree: true })
    }
})();
