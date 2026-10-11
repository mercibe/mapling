// SPDX-FileCopyrightText: 2026 Benoit Mercier and Mapling contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Entry point in the page: connects the core to the shell (docs/BRIDGE.md, section 3).
// The page loads jsMind first, defines window.MindShell, and has an element #mapling.

import { Bridge } from './bridge.ts';
import { JsMindView } from './jsmind-view.ts';

declare global {
  interface Window {
    MindShell: { send(json: string): void };
    MindCore: { receive(json: string): void };
  }
}

const view = new JsMindView('mapling');
const bridge = new Bridge((json) => window.MindShell.send(json), view);
view.connect(bridge);
window.MindCore = { receive: (json) => bridge.receive(json) };
bridge.start();
