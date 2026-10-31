// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Entry point in the page: connects the core to the shell (docs/BRIDGE.md, section 3).
// The page loads jsMind first, defines window.MindShell, and has an element #mapling.

import { Bridge } from './bridge.ts';
import { JsMindView } from './jsmind-view.ts';
import { webLink } from './map.ts';

declare global {
  interface Window {
    MindShell: { send(json: string): void };
    MindCore: { receive(json: string): void; webLink(value: string): string | null };
  }
}

const view = new JsMindView('mapling');
const bridge = new Bridge((json) => window.MindShell.send(json), view);
view.connect(bridge);
// webLink: a shell can tell beforehand whether a link will be shown, by the very same rule.
window.MindCore = { receive: (json) => bridge.receive(json), webLink };
bridge.start();
