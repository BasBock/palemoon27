/* vim: set ts=2 et sw=2 tw=80: */
/* Any copyright is dedicated to the Public Domain.
 http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tests that the contextual menu shows the right items when clicking on a link
// in an attribute.

const TEST_URL = TEST_URL_ROOT + "doc_markup_links.html";
const STRINGS = Services.strings
  .createBundle("chrome://browser/locale/devtools/inspector.properties");

// The test case array contains objects with the following properties:
// - selector: css selector for the node to select in the inspector
// - attributeName: name of the attribute to test
// - popupNodeSelector: css selector for the element inside the attribute
//   element to use as the contextual menu anchor
// - isLinkFollowItemVisible: is the follow-link item expected to be displayed
// - isLinkCopyItemVisible: is the copy-link item expected to be displayed
// - linkFollowItemLabel: the expected label of the follow-link item
// - linkCopyItemLabel: the expected label of the copy-link item
const TEST_DATA = [{
  selector: "link",
  attributeName: "href",
  popupNodeSelector: ".link",
  isLinkFollowItemVisible: true,
  isLinkCopyItemVisible: true,
  linkFollowItemLabel: STRINGS.GetStringFromName("inspector.menu.openUrlInNewTab.label"),
  linkCopyItemLabel: STRINGS.GetStringFromName("inspector.menu.copyUrlToClipboard.label")
}, {
  selector: "link[rel=icon]",
  attributeName: "href",
  popupNodeSelector: ".link",
  isLinkFollowItemVisible: true,
  isLinkCopyItemVisible: true,
  linkFollowItemLabel: STRINGS.GetStringFromName("inspector.menu.openUrlInNewTab.label"),
  linkCopyItemLabel: STRINGS.GetStringFromName("inspector.menu.copyUrlToClipboard.label")
}, {
  selector: "link",
  attributeName: "rel",
  popupNodeSelector: ".attr-value",
  isLinkFollowItemVisible: false,
  isLinkCopyItemVisible: false
}, {
  selector: "output",
  attributeName: "for",
  popupNodeSelector: ".link",
  isLinkFollowItemVisible: true,
  isLinkCopyItemVisible: false,
  linkFollowItemLabel: STRINGS.formatStringFromName(
    "inspector.menu.selectElement.label", ["name"], 1)
}, {
  selector: "script",
  attributeName: "src",
  popupNodeSelector: ".link",
  isLinkFollowItemVisible: true,
  isLinkCopyItemVisible: true,
  linkFollowItemLabel: STRINGS.GetStringFromName("inspector.menu.openUrlInNewTab.label"),
  linkCopyItemLabel: STRINGS.GetStringFromName("inspector.menu.copyUrlToClipboard.label")
}, {
  selector: "p[for]",
  attributeName: "for",
  popupNodeSelector: ".attr-value",
  isLinkFollowItemVisible: false,
  isLinkCopyItemVisible: false
}];

add_task(function*() {
  let {inspector} = yield addTab(TEST_URL).then(openInspector);

  let linkFollow = inspector.panelDoc.getElementById("node-menu-link-follow");
  let linkCopy = inspector.panelDoc.getElementById("node-menu-link-copy");

  for (let test of TEST_DATA) {
    info("Selecting test node " + test.selector);
    yield selectNode(test.selector, inspector);

    info("Finding the popupNode to anchor the context-menu to");
    let {editor} = yield getContainerForSelector(test.selector, inspector);
    let popupNode = editor.attrElements.get(test.attributeName)
                    .querySelector(test.popupNodeSelector);
    ok(popupNode, "Found the popupNode in attribute " + test.attributeName);

    info("Simulating a context click on the popupNode");
    contextMenuClick(popupNode);

    // The contextual menu setup is async, because it needs to know if the
    // inspector has the resolveRelativeURL method first. So call actorHasMethod
    // here too to make sure the first call resolves first and the menu is
    // properly setup.
    yield inspector.target.actorHasMethod("inspector", "resolveRelativeURL");

    is(linkFollow.hasAttribute("hidden"), !test.isLinkFollowItemVisible,
      "The follow-link item display is correct");
    is(linkCopy.hasAttribute("hidden"), !test.isLinkCopyItemVisible,
      "The copy-link item display is correct");

    if (test.isLinkFollowItemVisible) {
      is(linkFollow.getAttribute("label"), test.linkFollowItemLabel,
        "the follow-link label is correct");
    }
    if (test.isLinkCopyItemVisible) {
      is(linkCopy.getAttribute("label"), test.linkCopyItemLabel,
        "the copy-link label is correct");
    }
  }
});
