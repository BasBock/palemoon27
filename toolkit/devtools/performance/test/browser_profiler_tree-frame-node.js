/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Verifies if FrameNodes retain and parse their data appropriately.
 */

function test() {
  let { FrameNode } = devtools.require("devtools/performance/tree-model");
  let { CATEGORY_OTHER } = devtools.require("devtools/performance/global");

  let frame1 = new FrameNode("hello/<.world (http://foo/bar.js:123:987)", {
    location: "hello/<.world (http://foo/bar.js:123:987)",
    line: 456,
    isContent: FrameNode.isContent({
      location: "hello/<.world (http://foo/bar.js:123:987)"
    })
  }, false);

  is(frame1.getInfo().nodeType, "Frame",
    "The first frame node has the correct type.");
  is(frame1.getInfo().functionName, "hello/<.world",
    "The first frame node has the correct function name.");
  is(frame1.getInfo().fileName, "bar.js",
    "The first frame node has the correct file name.");
  is(frame1.getInfo().hostName, "foo",
    "The first frame node has the correct host name.");
  is(frame1.getInfo().url, "http://foo/bar.js",
    "The first frame node has the correct url.");
  is(frame1.getInfo().line, 123,
    "The first frame node has the correct line.");
  is(frame1.getInfo().column, 987,
    "The first frame node has the correct column.");
  is(frame1.getInfo().categoryData.toSource(), "({})",
    "The first frame node has the correct category data.");
  is(frame1.getInfo().isContent, true,
    "The first frame node has the correct content flag.");

  let frame2 = new FrameNode("hello/<.world (http://foo/bar.js#baz:123:987)", {
    location: "hello/<.world (http://foo/bar.js#baz:123:987)",
    line: 456,
    isContent: FrameNode.isContent({
      location: "hello/<.world (http://foo/bar.js#baz:123:987)"
    })
  }, false);

  is(frame2.getInfo().nodeType, "Frame",
    "The second frame node has the correct type.");
  is(frame2.getInfo().functionName, "hello/<.world",
    "The second frame node has the correct function name.");
  is(frame2.getInfo().fileName, "bar.js#baz",
    "The second frame node has the correct file name.");
  is(frame2.getInfo().hostName, "foo",
    "The second frame node has the correct host name.");
  is(frame2.getInfo().url, "http://foo/bar.js#baz",
    "The second frame node has the correct url.");
  is(frame2.getInfo().line, 123,
    "The second frame node has the correct line.");
  is(frame2.getInfo().column, 987,
    "The second frame node has the correct column.");
  is(frame2.getInfo().categoryData.toSource(), "({})",
    "The second frame node has the correct category data.");
  is(frame2.getInfo().isContent, true,
    "The second frame node has the correct content flag.");

  let frame3 = new FrameNode("hello/<.world (http://foo/#bar:123:987)", {
    location: "hello/<.world (http://foo/#bar:123:987)",
    line: 456,
    isContent: FrameNode.isContent({
      location: "hello/<.world (http://foo/#bar:123:987)"
    })
  }, false);

  is(frame3.getInfo().nodeType, "Frame",
    "The third frame node has the correct type.");
  is(frame3.getInfo().functionName, "hello/<.world",
    "The third frame node has the correct function name.");
  is(frame3.getInfo().fileName, "#bar",
    "The third frame node has the correct file name.");
  is(frame3.getInfo().hostName, "foo",
    "The third frame node has the correct host name.");
  is(frame3.getInfo().url, "http://foo/#bar",
    "The third frame node has the correct url.");
  is(frame3.getInfo().line, 123,
    "The third frame node has the correct line.");
  is(frame3.getInfo().column, 987,
    "The third frame node has the correct column.");
  is(frame3.getInfo().categoryData.toSource(), "({})",
    "The third frame node has the correct category data.");
  is(frame3.getInfo().isContent, true,
    "The third frame node has the correct content flag.");

  let frame4 = new FrameNode("hello/<.world (http://foo/:123:987)", {
    location: "hello/<.world (http://foo/:123:987)",
    line: 456,
    isContent: FrameNode.isContent({
      location: "hello/<.world (http://foo/:123:987)"
    })
  }, false);

  is(frame4.getInfo().nodeType, "Frame",
    "The fourth frame node has the correct type.");
  is(frame4.getInfo().functionName, "hello/<.world",
    "The fourth frame node has the correct function name.");
  is(frame4.getInfo().fileName, "/",
    "The fourth frame node has the correct file name.");
  is(frame4.getInfo().hostName, "foo",
    "The fourth frame node has the correct host name.");
  is(frame4.getInfo().url, "http://foo/",
    "The fourth frame node has the correct url.");
  is(frame4.getInfo().line, 123,
    "The fourth frame node has the correct line.");
  is(frame4.getInfo().column, 987,
    "The fourth frame node has the correct column.");
  is(frame4.getInfo().categoryData.toSource(), "({})",
    "The fourth frame node has the correct category data.");
  is(frame4.getInfo().isContent, true,
    "The fourth frame node has the correct content flag.");

  let frame5 = new FrameNode("hello/<.world (resource://foo.js -> http://bar/baz.js:123:987)", {
    location: "hello/<.world (resource://foo.js -> http://bar/baz.js:123:987)",
    line: 456,
    isContent: FrameNode.isContent({
      location: "hello/<.world (resource://foo.js -> http://bar/baz.js:123:987)"
    })
  }, false);

  is(frame5.getInfo().nodeType, "Frame",
    "The fifth frame node has the correct type.");
  is(frame5.getInfo().functionName, "hello/<.world",
    "The fifth frame node has the correct function name.");
  is(frame5.getInfo().fileName, "baz.js",
    "The fifth frame node has the correct file name.");
  is(frame5.getInfo().hostName, "bar",
    "The fifth frame node has the correct host name.");
  is(frame5.getInfo().url, "http://bar/baz.js",
    "The fifth frame node has the correct url.");
  is(frame5.getInfo().line, 123,
    "The fifth frame node has the correct line.");
  is(frame5.getInfo().column, 987,
    "The fifth frame node has the correct column.");
  is(frame5.getInfo().categoryData.toSource(), "({})",
    "The fifth frame node has the correct category data.");
  is(frame5.getInfo().isContent, false,
    "The fifth frame node has the correct content flag.");

  let frame6 = new FrameNode("Foo::Bar::Baz", {
    location: "Foo::Bar::Baz",
    line: 456,
    category: CATEGORY_OTHER,
    isContent: FrameNode.isContent({
      location: "Foo::Bar::Baz",
      category: CATEGORY_OTHER
    })
  }, false);

  is(frame6.getInfo().nodeType, "Frame",
    "The sixth frame node has the correct type.");
  is(frame6.getInfo().functionName, "Foo::Bar::Baz",
    "The sixth frame node has the correct function name.");
  is(frame6.getInfo().fileName, null,
    "The sixth frame node has the correct file name.");
  is(frame6.getInfo().hostName, null,
    "The sixth frame node has the correct host name.");
  is(frame6.getInfo().url, null,
    "The sixth frame node has the correct url.");
  is(frame6.getInfo().line, 456,
    "The sixth frame node has the correct line.");
  is(frame6.getInfo().categoryData.abbrev, "other",
    "The sixth frame node has the correct category data.");
  is(frame6.getInfo().isContent, false,
    "The sixth frame node has the correct content flag.");

  let frame7 = new FrameNode("EnterJIT", {
    location: "EnterJIT",
    isContent: FrameNode.isContent({
      location: "EnterJIT"
    })
  }, false);

  is(frame7.getInfo().nodeType, "Frame",
    "The seventh frame node has the correct type.");
  is(frame7.getInfo().functionName, "EnterJIT",
    "The seventh frame node has the correct function name.");
  is(frame7.getInfo().fileName, null,
    "The seventh frame node has the correct file name.");
  is(frame7.getInfo().hostName, null,
    "The seventh frame node has the correct host name.");
  is(frame7.getInfo().url, null,
    "The seventh frame node has the correct url.");
  is(frame7.getInfo().line, null,
    "The seventh frame node has the correct line.");
  is(frame7.getInfo().column, null,
    "The seventh frame node has the correct column.");
  is(frame7.getInfo().categoryData.abbrev, "js",
    "The seventh frame node has the correct category data.");
  is(frame7.getInfo().isContent, false,
    "The seventh frame node has the correct content flag.");

  let frame8 = new FrameNode("chrome://browser/content/content.js", {
    location: "chrome://browser/content/content.js",
    line: 456,
    column: 123
  }, false);

  is(frame8.getInfo().hostName, null,
    "The eighth frame node has the correct host name.");

  let frame9 = new FrameNode("hello/<.world (resource://gre/foo.js:123:434)", {
    location: "hello/<.world (resource://gre/foo.js:123:434)",
    line: 456
  }, false);

  is(frame9.getInfo().hostName, null,
    "The ninth frame node has the correct host name.");

  let frame10 = new FrameNode("main (http://localhost:8888/file.js:123:987)", {
    location: "main (http://localhost:8888/file.js:123:987)",
    line: 123,
    isContent: FrameNode.isContent({
      location: "main (http://localhost:8888/file.js:123:987)"
    })
  }, false);

  is(frame10.getInfo().nodeType, "Frame",
    "The tenth frame node has the correct type.");
  is(frame10.getInfo().functionName, "main",
    "The tenth frame node has the correct function name.");
  is(frame10.getInfo().fileName, "file.js",
    "The tenth frame node has the correct file name.");
  is(frame10.getInfo().hostName, "localhost",
    "The tenth frame node has the correct host name.");
  is(frame10.getInfo().url, "http://localhost:8888/file.js",
    "The tenth frame node has the correct url.");
  is(frame10.getInfo().line, 123,
    "The tenth frame node has the correct line.");
  is(frame10.getInfo().column, 987,
    "The tenth frame node has the correct column.");
  is(frame10.getInfo().isContent, true,
    "The tenth frame node has the correct content flag.");
  is(frame10.getInfo().host, "localhost:8888",
    "The tenth frame node has the correct host.");
  is(frame10.getInfo().port, 8888,
    "The tenth frame node has the correct port.");

  finish();
}
