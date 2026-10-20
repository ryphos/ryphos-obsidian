import assert from "node:assert/strict";
import { test } from "node:test";
import { hashMarkdown } from "../src/core/docs-core";

// Hashes calculados con hashMarkdown del SERVIDOR (pandup-manager-api wiki/util/wiki-markdown.util.ts).
// Si este test falla, el CLI y el servidor ven cambios distintos: falsos conflictos en la sync.
const FIXTURES: Array<[string, string]> = [
    [
        "hola",
        "b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79"
    ],
    [
        "---\nryphos_id: x\ntitle: T\n---\n\n# T\n\ntexto\n\n",
        "9569ee5b4eaf6a3de967a83b10216ba7e87307fbd4bd72e65f6b3f59fdc91d4c"
    ],
    [
        "﻿---\r\ntags: [a]\r\n---\r\nA\r\nB  \r\n",
        "23519a43c66b4c342f25b32e09797ec5f3fc0be388cd8243fb3449afbdce4013"
    ],
    [
        "---  \nno\n---\nx",
        "2aec5033297ba7784a183064ab2dbb75be2c46b16a97369edca21d9159f7bb90"
    ],
    [
        "---\n---\nhola",
        "b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79"
    ],
    [
        "",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    ],
    [
        "\n\n# x\n",
        "44647510631c98185d84603cb34a79e028914924a4a03db8ce04f7b49504486f"
    ],
    [
        "---\nsin cierre\nbody",
        "73eaf56858d2451dab72bea84b3eb467fe295f9cfc31ab697f3caf7606a9834b"
    ]
];

test("hashMarkdown coincide con el servidor", () => {
    for (const [md, expected] of FIXTURES) assert.equal(hashMarkdown(md), expected, JSON.stringify(md));
});
