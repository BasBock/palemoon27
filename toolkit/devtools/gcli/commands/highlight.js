/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {Cc, Ci, Cu} = require("chrome");
const l10n = require("gcli/l10n");
require("devtools/server/actors/inspector");
const {BoxModelHighlighter} = require("devtools/server/actors/highlighter");

XPCOMUtils.defineLazyGetter(this, "nodesSelected", function() {
  return Services.strings.createBundle("chrome://global/locale/devtools/gclicommands.properties");
});
XPCOMUtils.defineLazyModuleGetter(this, "PluralForm","resource://gre/modules/PluralForm.jsm");
const events = require("sdk/event/core");

// How many maximum nodes can be highlighted in parallel
const MAX_HIGHLIGHTED_ELEMENTS = 100;

// Stores the highlighters instances so they can be destroyed later.
// also export them so tests can access those and assert they got created
// correctly.
exports.highlighters = [];

/**
 * Destroy all existing highlighters
 */
function unhighlightAll() {
  for (let highlighter of exports.highlighters) {
    highlighter.destroy();
  }
  exports.highlighters.length = 0;
}

exports.items = [
  {
    item: "command",
    runAt: "server",
    name: "highlight",
    description: l10n.lookup("highlightDesc"),
    manual: l10n.lookup("highlightManual"),
    params: [
      {
        name: "selector",
        type: "nodelist",
        description: l10n.lookup("highlightSelectorDesc"),
        manual: l10n.lookup("highlightSelectorManual")
      },
      {
        group: l10n.lookup("highlightOptionsDesc"),
        params: [
          {
            name: "hideguides",
            type: "boolean",
            description: l10n.lookup("highlightHideGuidesDesc"),
            manual: l10n.lookup("highlightHideGuidesManual")
          },
          {
            name: "showinfobar",
            type: "boolean",
            description: l10n.lookup("highlightShowInfoBarDesc"),
            manual: l10n.lookup("highlightShowInfoBarManual")
          },
          {
            name: "showall",
            type: "boolean",
            description: l10n.lookup("highlightShowAllDesc"),
            manual: l10n.lookup("highlightShowAllManual")
          },
          {
            name: "region",
            type: {
              name: "selection",
              data: ["content", "padding", "border", "margin"]
            },
            description: l10n.lookup("highlightRegionDesc"),
            manual: l10n.lookup("highlightRegionManual"),
            defaultValue: "border"
          },
          {
            name: "fill",
            type: "string",
            description: l10n.lookup("highlightFillDesc"),
            manual: l10n.lookup("highlightFillManual"),
            defaultValue: null
          },
          {
            name: "keep",
            type: "boolean",
            description: l10n.lookup("highlightKeepDesc"),
            manual: l10n.lookup("highlightKeepManual"),
          }
        ]
      }
    ],
    exec: function(args, context) {
      // Remove all existing highlighters unless told otherwise
      if (!args.keep) {
        unhighlightAll();
      }

      let env = context.environment;

      // Unhighlight on navigate
      events.on(env.__deprecatedTabActor, "will-navigate", unhighlightAll);

      let i = 0;
      for (let node of args.selector) {
        if (!args.showall && i >= MAX_HIGHLIGHTED_ELEMENTS) {
          break;
        }

        let highlighter = new BoxModelHighlighter(env.__deprecatedTabActor);
        if (args.fill) {
          highlighter.regionFill[args.region] = args.fill;
        }
        highlighter.show(node, {
          region: args.region,
          hideInfoBar: !args.showinfobar,
          hideGuides: args.hideguides,
          showOnly: args.region
        });
        exports.highlighters.push(highlighter);
        i++;
      }

      let highlightText = nodesSelected.GetStringFromName("highlightOutputConfirm2");
      let output = PluralForm.get(args.selector.length, highlightText)
                             .replace("%1$S", args.selector.length);
      if (args.selector.length > i) {
        output = l10n.lookupFormat("highlightOutputMaxReached",
          ["" + args.selector.length, "" + i]);
      }

      return output;
    }
  },
  {
    item: "command",
    runAt: "server",
    name: "unhighlight",
    description: l10n.lookup("unhighlightDesc"),
    manual: l10n.lookup("unhighlightManual"),
    exec: unhighlightAll
  }
];
