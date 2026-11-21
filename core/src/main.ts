// SPDX-FileCopyrightText: 2026 Benoit Mercier
// SPDX-License-Identifier: GPL-3.0-or-later

// Entry point in the page: connects the core to the shell (docs/BRIDGE.md, section 3).
// The page loads jsMind first, defines window.MindShell, and has an element #mapling.

import { Bridge } from './bridge.ts';
import { JsMindView } from './jsmind-view.ts';
import { typedLink, webLink } from './map.ts';

declare global {
  interface Window {
    MindShell: { send(json: string): void };
    MindCore: { receive(json: string): void; webLink(value: string): string | null; typedLink(text: string, current?: string | null): string };
  }
}

const view = new JsMindView('mapling');
const bridge = new Bridge((json) => window.MindShell.send(json), view);
view.connect(bridge);
// webLink(typedLink(text, link)): a shell can tell beforehand whether the link typed for a
// node whose link is `link` will be shown, by the very same rules.
window.MindCore = { receive: (json) => bridge.receive(json), webLink, typedLink };
bridge.start();
