/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu, results: Cr} = Components;

const loader = Cc["@mozilla.org/moz/jssubscript-loader;1"]
    .getService(Ci.mozIJSSubScriptLoader);

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/Log.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Task.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

let {devtools} = Cu.import("resource://gre/modules/devtools/Loader.jsm", {});
this.DevToolsUtils = devtools.require("devtools/toolkit/DevToolsUtils.js");

XPCOMUtils.defineLazyServiceGetter(
    this, "cookieManager", "@mozilla.org/cookiemanager;1", "nsICookieManager");

Cu.import("chrome://marionette/content/emulator.js");
Cu.import("chrome://marionette/content/error.js");
Cu.import("chrome://marionette/content/marionette-elements.js");
Cu.import("chrome://marionette/content/marionette-simpletest.js");

loader.loadSubScript("chrome://marionette/content/marionette-common.js");

// preserve this import order:
let utils = {};
loader.loadSubScript("chrome://marionette/content/EventUtils.js", utils);
loader.loadSubScript("chrome://marionette/content/ChromeUtils.js", utils);
loader.loadSubScript("chrome://marionette/content/atoms.js", utils);
loader.loadSubScript("chrome://marionette/content/marionette-sendkeys.js", utils);
loader.loadSubScript("chrome://marionette/content/marionette-frame-manager.js");

this.EXPORTED_SYMBOLS = ["GeckoDriver", "Context"];

const FRAME_SCRIPT = "chrome://marionette/content/marionette-listener.js";
const BROWSER_STARTUP_FINISHED = "browser-delayed-startup-finished";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const SECURITY_PREF = "security.turn_off_all_security_so_that_viruses_can_take_over_this_computer";
const CLICK_TO_START_PREF = "marionette.debugging.clicktostart";
const CONTENT_LISTENER_PREF = "marionette.contentListener";
const COMMON_DIALOG_LOADED = "common-dialog-loaded";
const TABMODAL_DIALOG_LOADED = "tabmodal-dialog-loaded";

const logger = Log.repository.getLogger("Marionette");
const uuidGen = Cc["@mozilla.org/uuid-generator;1"].getService(Ci.nsIUUIDGenerator);
const globalMessageManager = Cc["@mozilla.org/globalmessagemanager;1"]
    .getService(Ci.nsIMessageBroadcaster);
let specialpowers = {};

// This is used to prevent newSession from returning before the telephony
// API's are ready; see bug 792647.  This assumes that marionette-server.js
// will be loaded before the 'system-message-listener-ready' message
// is fired.  If this stops being true, this approach will have to change.
let systemMessageListenerReady = false;
Services.obs.addObserver(function() {
  systemMessageListenerReady = true;
}, "system-message-listener-ready", false);

// This is used on desktop to prevent newSession from returning before a page
// load initiated by the Firefox command line has completed.
let delayedBrowserStarted = false;
Services.obs.addObserver(function () {
  delayedBrowserStarted = true;
}, BROWSER_STARTUP_FINISHED, false);

this.Context = {
  CHROME: "chrome",
  CONTENT: "content",
};

this.Context.fromString = function(s) {
  s = s.toUpperCase();
  if (s in this)
    return this[s];
  return null;
};

/**
 * Creates a transparent interface between the chrome- and content
 * processes.
 *
 * Calls to this object will  be proxied via the message manager to the active
 * browsing context (content) and responses will be provided back as
 * promises.
 *
 * The argument sequence is serialised and passed as an array, unless it
 * consists of a single object type that isn't null, in which case it's
 * passed literally.  The latter specialisation is temporary to achieve
 * backwards compatibility with marionette-listener.js.
 *
 * @param {function(): nsIMessageManager} mmFn
 *     Function returning the current message manager.
 * @param {function(string, Object, number)} sendAsyncFn
 *     Callback for sending async messages to the current listener.
 * @param {function(): BrowserObj} curBrowserFn
 *     Function that returns the current browser.
 */
let ListenerProxy = function(mmFn, sendAsyncFn, curBrowserFn) {
  this.curCmdId = null;
  this.sendAsync = sendAsyncFn;
  this.ondialog = d => {};

  this.mmFn_ = mmFn;
  this.curBrowserFn_ = curBrowserFn;
};

Object.defineProperty(ListenerProxy.prototype, "mm", {
  get: function() { return this.mmFn_(); }
});

Object.defineProperty(ListenerProxy.prototype, "curBrowser", {
  get: function() { return this.curBrowserFn_(); }
});

ListenerProxy.prototype.__noSuchMethod__ = function*(name, args) {
  const ok = "Marionette:ok";
  const val = "Marionette:done";
  const err = "Marionette:error";
  const all = [ok, val, err];

  let proxy = new Promise((resolve, reject) => {
    let listeners = [];
    let obs = new Map();
    obs.add = function(modalHandler) {
      if (Services.appinfo.name != "Firefox")
        return;
      this.set(COMMON_DIALOG_LOADED, modalHandler);
      this.set(TABMODAL_DIALOG_LOADED, modalHandler);
      for (let [t,o] of this) {
        Services.obs.addObserver(o, t, false);
      }
    };
    obs.remove = function() {
      for (let [t,o] of this) {
        Services.obs.removeObserver(o, t);
      }
    };

    let okListener = () => resolve();
    let valListener = msg => resolve(msg.json.value);
    let errListener = msg => reject(
        "error" in msg.objects ? msg.objects.error : msg.json);

    let handleDialogLoad = function(subject, topic) {
      obs.remove();
      this.cancelRequest();

      // we shouldn't return to the client due to the modal associated with the
      // jsdebugger
      let clickToStart;
      try {
        clickToStart = Services.prefs.getBoolPref(CLICK_TO_START_PREF);
      } catch (e) {}
      if (clickToStart) {
        Services.prefs.setBoolPref(CLICK_TO_START_PREF, false);
        return;
      }

      let winr;
      if (topic == COMMON_DIALOG_LOADED)
        winr = Cu.getWeakReference(subject);
      let d = new ModalDialog(() => this.curBrowser, winr);
      this.ondialog(d);

      // shortcut to return a response immediately,
      // causes next reply from listener to be out-of-sync
      resolve();
    };

    let removeListeners = (name, listenerFn) => {
      let fn = msg => {
        if (this.isOutOfSync(msg.json.command_id)) {
          logger.warn("Skipping out-of-sync response from listener: " +
              msg.name + msg.json.toSource());
          return;
        }

        listeners.map(l => this.mm.removeMessageListener(l[0], l[1]));
        obs.remove();

        listenerFn(msg);
        this.curCmdId = null;
      };

      listeners.push([name, fn]);
      return fn;
    };

    this.mm.addMessageListener(ok, removeListeners(ok, okListener));
    this.mm.addMessageListener(val, removeListeners(val, valListener));
    this.mm.addMessageListener(err, removeListeners(err, errListener));

    // install observers for global- and tab modal dialogues
    obs.add(handleDialogLoad.bind(this));

    // convert to array if passed arguments
    let msg;
    if (args.length == 1 && typeof args[0] == "object" && args[0] !== null)
      msg = args[0];
    else
      msg = Array.prototype.slice.call(args);

    this.sendAsync(name, msg, this.curCmdId);
  });

  return proxy;
};

ListenerProxy.prototype.isOutOfSync = function(id) {
  return this.curCmdId !== id;
};

/**
 * Implements (parts of) the W3C WebDriver protocol.  GeckoDriver lives
 * in the chrome context and mediates content calls to the listener via
 * ListenerProxy.
 *
 * Throughout this prototype, functions with the argument {@code cmd}'s
 * documentation refers to the contents of the {@code cmd.parameters}
 * object.
 *
 * @param {string} appName
 *     Description of the product, for example "B2G" or "Firefox".
 * @param {string} device
 *     Device this driver should assume.
 * @param {Emulator=} emulator
 *     Reference to the emulator connection, if running on an emulator.
 */
this.GeckoDriver = function(appName, device, emulator) {
  this.appName = appName;
  this.emulator = emulator;

  this.sessionId = null;
  // holds list of BrowserObjs
  this.browsers = {};
  // points to current browser
  this.curBrowser = null;
  this.context = Context.CONTENT;
  this.scriptTimeout = null;
  this.searchTimeout = null;
  this.pageTimeout = null;
  this.timer = null;
  this.inactivityTimer = null;
  // called by simpletest methods
  this.heartbeatCallback = function() {};
  this.marionetteLog = new MarionetteLogObj();
  // topmost chrome frame
  this.mainFrame = null;
  // chrome iframe that currently has focus
  this.curFrame = null;
  this.mainContentFrameId = null;
  this.importedScripts = FileUtils.getFile("TmpD", ["marionetteChromeScripts"]);
  this.importedScriptHashes = {};
  this.importedScriptHashes[Context.CONTENT] = [];
  this.importedScriptHashes[Context.CHROME] = [];
  this.currentFrameElement = null;
  this.testName = null;
  this.mozBrowserClose = null;
  this.enabled_security_pref = false;
  this.sandbox = null;
  // frame ID of the current remote frame, used for mozbrowserclose events
  this.oopFrameId = null;
  this.observing = null;
  this._browserIds = new WeakMap();
  this.dialog = null;

  this.sessionCapabilities = {
    // Mandated capabilities
    "browserName": this.appName,
    "browserVersion": Services.appinfo.version,
    "platformName": Services.appinfo.OS.toUpperCase(),
    "platformVersion": Services.appinfo.platformVersion,

    // Supported features
    "handlesAlerts": false,
    "nativeEvents": false,
    "raisesAccessibilityExceptions": false,
    "rotatable": this.appName == "B2G",
    "secureSsl": false,
    "takesElementScreenshot": true,
    "takesScreenshot": true,

    // Selenium 2 compat
    "platform": Services.appinfo.OS.toUpperCase(),

    // Proprietary extensions
    "XULappId" : Services.appinfo.ID,
    "appBuildId" : Services.appinfo.appBuildID,
    "device": device,
    "version": Services.appinfo.version
  };

  this.mm = globalMessageManager;
  this.listener = new ListenerProxy(
      () => this.mm,
      this.sendAsync.bind(this),
      () => this.curBrowser);
  this.listener.ondialog = d => this.dialog = d;
};

GeckoDriver.prototype.QueryInterface = XPCOMUtils.generateQI([
  Ci.nsIMessageListener,
  Ci.nsIObserver,
  Ci.nsISupportsWeakReference
]);

/**
 * Switches to the global ChromeMessageBroadcaster, potentially replacing
 * a frame-specific ChromeMessageSender.  Has no effect if the global
 * ChromeMessageBroadcaster is already in use.  If this replaces a
 * frame-specific ChromeMessageSender, it removes the message listeners
 * from that sender, and then puts the corresponding frame script "to
 * sleep", which removes most of the message listeners from it as well.
 */
GeckoDriver.prototype.switchToGlobalMessageManager = function() {
  if (this.curBrowser && this.curBrowser.frameManager.currentRemoteFrame !== null) {
    this.curBrowser.frameManager.removeMessageManagerListeners(this.mm);
    this.sendAsync("sleepSession");
    this.curBrowser.frameManager.currentRemoteFrame = null;
  }
  this.mm = globalMessageManager;
};

/**
 * Helper method to send async messages to the content listener.
 * Correct usage is to pass in the name of a function in marionette-listener.js,
 * a message object consisting of JSON serialisable primitives,
 * and the current command's ID.
 *
 * @param {string} name
 *     Suffix of the targetted message listener ({@code Marionette:<suffix>}).
 * @param {Object=} msg
 *     JSON serialisable object to send to the listener.
 * @param {number=} cmdId
 *     Command ID to ensure synchronisity.
 */
GeckoDriver.prototype.sendAsync = function(name, msg, cmdId) {
  let curRemoteFrame = this.curBrowser.frameManager.currentRemoteFrame;
  name = `Marionette:${name}`;

  if (cmdId)
    msg.command_id = cmdId;

  if (curRemoteFrame === null) {
    this.curBrowser.executeWhenReady(() => {
      this.mm.broadcastAsyncMessage(name + this.curBrowser.curFrameId, msg);
    });
  } else {
    let remoteFrameId = curRemoteFrame.targetFrameId;
    try {
      this.mm.sendAsyncMessage(name + remoteFrameId, msg);
    } catch (e) {
      switch(e.result) {
        case Components.results.NS_ERROR_FAILURE:
          throw new FrameSendFailureError(curRemoteFrame);
        case Components.results.NS_ERROR_NOT_INITIALIZED:
          throw new FrameSendNotInitializedError(curRemoteFrame);
        default:
          throw new WebDriverError(e.toString());
      }
    }
  }
};

/**
 * Gets the current active window.
 *
 * @return {nsIDOMWindow}
 */
GeckoDriver.prototype.getCurrentWindow = function() {
  let typ = null;
  if (this.curFrame == null) {
    if (this.curBrowser == null) {
      if (this.context == Context.CONTENT) {
        typ = 'navigator:browser';
      }
      return Services.wm.getMostRecentWindow(typ);
    } else {
      return this.curBrowser.window;
    }
  } else {
    return this.curFrame;
  }
};

/**
 * Gets the the window enumerator.
 *
 * @return {nsISimpleEnumerator}
 */
GeckoDriver.prototype.getWinEnumerator = function() {
  let typ = null;
  if (this.appName != "B2G" && this.context == Context.CONTENT) {
    typ = "navigator:browser";
  }
  return Services.wm.getEnumerator(typ);
};

GeckoDriver.prototype.addFrameCloseListener = function(action) {
  let win = this.getCurrentWindow();
  this.mozBrowserClose = e => {
    if (e.target.id == this.oopFrameId) {
      win.removeEventListener("mozbrowserclose", this.mozBrowserClose, true);
      this.switchToGlobalMessageManager();
      throw new FrameSendFailureError(
          `The frame closed during the ${action}, recovering to allow further communications`);
    }
  };
  win.addEventListener("mozbrowserclose", this.mozBrowserClose, true);
};

/**
 * Create a new BrowserObj for window and add to known browsers.
 *
 * @param {nsIDOMWindow} win
 *     Window for which we will create a BrowserObj.
 *
 * @return {string}
 *     Returns the unique server-assigned ID of the window.
 */
GeckoDriver.prototype.addBrowser = function(win) {
  let browser = new BrowserObj(win, this);
  let winId = win.QueryInterface(Ci.nsIInterfaceRequestor)
      .getInterface(Ci.nsIDOMWindowUtils).outerWindowID;
  winId = winId + ((this.appName == "B2G") ? "-b2g" : "");
  this.browsers[winId] = browser;
  this.curBrowser = this.browsers[winId];
  if (typeof this.curBrowser.elementManager.seenItems[winId] == "undefined") {
    // add this to seenItems so we can guarantee
    // the user will get winId as this window's id
    this.curBrowser.elementManager.seenItems[winId] = Cu.getWeakReference(win);
  }
};

/**
 * Registers a new browser, win, with Marionette.
 *
 * If we have not seen the browser content window before, the listener
 * frame script will be loaded into it.  If isNewSession is true, we will
 * switch focus to the start frame when it registers.
 *
 * @param {nsIDOMWindow} win
 *     Window whose browser we need to access.
 * @param {boolean=false} isNewSession
 *     True if this is the first time we're talking to this browser.
 */
GeckoDriver.prototype.startBrowser = function(win, isNewSession=false) {
  this.mainFrame = win;
  this.curFrame = null;
  this.addBrowser(win);
  this.curBrowser.isNewSession = isNewSession;
  this.curBrowser.startSession(isNewSession, win, this.whenBrowserStarted.bind(this));
};

/**
 * Callback invoked after a new session has been started in a browser.
 * Loads the Marionette frame script into the browser if needed.
 *
 * @param {nsIDOMWindow} win
 *     Window whose browser we need to access.
 * @param {boolean} isNewSession
 *     True if this is the first time we're talking to this browser.
 */
GeckoDriver.prototype.whenBrowserStarted = function(win, isNewSession) {
  utils.window = win;

  try {
    let mm = win.window.messageManager;
    if (!isNewSession) {
      // Loading the frame script corresponds to a situation we need to
      // return to the server. If the messageManager is a message broadcaster
      // with no children, we don't have a hope of coming back from this call,
      // so send the ack here. Otherwise, make a note of how many child scripts
      // will be loaded so we known when it's safe to return.
      if (mm.childCount != 0) {
        this.curBrowser.frameRegsPending = mm.childCount;
      }
    }

    if (!Services.prefs.getBoolPref("marionette.contentListener") || !isNewSession) {
      mm.loadFrameScript(FRAME_SCRIPT, true, true);
      Services.prefs.setBoolPref("marionette.contentListener", true);
    }
  } catch (e) {
    // there may not always be a content process
    logger.error(
        `Could not load listener into content for page ${win.location.href}: ${e}`);
  }
};

/**
 * Recursively get all labeled text.
 *
 * @param {nsIDOMElement} el
 *     The parent element.
 * @param {Array.<string>} lines
 *      Array that holds the text lines.
 */
GeckoDriver.prototype.getVisibleText = function(el, lines) {
  try {
    if (utils.isElementDisplayed(el)) {
      if (el.value) {
        lines.push(el.value);
      }
      for (let child in el.childNodes) {
        this.getVisibleText(el.childNodes[child], lines);
      }
    }
  } catch (e) {
    if (el.nodeName == "#text") {
      lines.push(el.textContent);
    }
  }
};

/**
  * Given a file name, this will delete the file from the temp directory
  * if it exists.
  *
  * @param {string} filename
  */
GeckoDriver.prototype.deleteFile = function(filename) {
  let file = FileUtils.getFile("TmpD", [filename.toString()]);
  if (file.exists())
    file.remove(true);
};

/**
 * Handles registration of new content listener browsers.  Depending on
 * their type they are either accepted or ignored.
 */
GeckoDriver.prototype.registerBrowser = function(id, be) {
  let nullPrevious = this.curBrowser.curFrameId == null;
  let listenerWindow = Services.wm.getOuterWindowWithId(id);

  // go in here if we're already in a remote frame
  if (this.curBrowser.frameManager.currentRemoteFrame !== null &&
      (!listenerWindow || this.mm == this.curBrowser.frameManager
          .currentRemoteFrame.messageManager.get())) {
    // The outerWindowID from an OOP frame will not be meaningful to
    // the parent process here, since each process maintains its own
    // independent window list.  So, it will either be null (!listenerWindow)
    // if we're already in a remote frame, or it will point to some
    // random window, which will hopefully cause an href mismatch.
    // Currently this only happens in B2G for OOP frames registered in
    // Marionette:switchToFrame, so we'll acknowledge the switchToFrame
    // message here.
    //
    // TODO: Should have a better way of determining that this message
    // is from a remote frame.
    this.curBrowser.frameManager.currentRemoteFrame.targetFrameId =
        this.generateFrameId(id);
  }

  let reg = {};
  // this will be sent to tell the content process if it is the main content
  let mainContent = this.curBrowser.mainContentId == null;
  if (be.getAttribute("type") != "content") {
    // curBrowser holds all the registered frames in knownFrames
    let uid = this.generateFrameId(id);
    reg.id = uid;
    reg.remotenessChange = this.curBrowser.register(uid, be);
  }

  // set to true if we updated mainContentId
  mainContent = mainContent == true &&
      this.curBrowser.mainContentId != null;
  if (mainContent)
    this.mainContentFrameId = this.curBrowser.curFrameId;

  this.curBrowser.elementManager.seenItems[reg.id] =
      Cu.getWeakReference(listenerWindow);
  if (nullPrevious && (this.curBrowser.curFrameId != null)) {
    this.sendAsync("newSession",
        {
          B2G: (this.appName == "B2G"),
          raisesAccessibilityExceptions:
              this.sessionCapabilities.raisesAccessibilityExceptions
        },
        this.newSessionCommandId);
    if (this.curBrowser.isNewSession)
      this.newSessionCommandId = null;
  }

  return [reg, mainContent];
};

GeckoDriver.prototype.registerPromise = function() {
  const li = "Marionette:register";

  return new Promise((resolve) => {
    this.mm.addMessageListener(li, function cb(msg) {
      let wid = msg.json.value;
      let be = msg.target;
      let rv = this.registerBrowser(wid, be);

      if (this.curBrowser.frameRegsPending > 0)
        this.curBrowser.frameRegsPending--;

      if (this.curBrowser.frameRegsPending == 0) {
        this.mm.removeMessageListener(li, cb);
        resolve();
      }

      // this is a sync message and listeners expect the ID back
      return rv;
    }.bind(this));
  });
};

GeckoDriver.prototype.listeningPromise = function() {
  const li = "Marionette:listenersAttached";
  return new Promise((resolve) => {
    this.mm.addMessageListener(li, function() {
      this.mm.removeMessageListener(li, this);
      resolve();
    }.bind(this));
  });
};

/** Create a new session. */
GeckoDriver.prototype.newSession = function(cmd, resp) {
  this.sessionId = cmd.parameters.sessionId ||
      cmd.parameters.session_id ||
      uuidGen.generateUUID().toString();

  this.newSessionCommandId = cmd.id;
  this.setSessionCapabilities(cmd.parameters.capabilities);
  this.scriptTimeout = 10000;

  // SpecialPowers requires insecure automation-only features that we
  // put behind a pref
  let sec = false;
  try {
    sec = Services.prefs.getBoolPref(SECURITY_PREF);
  } catch (e) {}
  if (!sec) {
    this.enabled_security_pref = true;
    Services.prefs.setBoolPref(SECURITY_PREF, true);
  }

  if (!specialpowers.hasOwnProperty("specialPowersObserver")) {
    loader.loadSubScript("chrome://specialpowers/content/SpecialPowersObserver.js",
        specialpowers);
    specialpowers.specialPowersObserver = new specialpowers.SpecialPowersObserver();
    specialpowers.specialPowersObserver.init();
    specialpowers.specialPowersObserver._loadFrameScript();
  }

  let registerBrowsers = this.registerPromise();
  let browserListening = this.listeningPromise();

  let waitForWindow = function() {
    let win = this.getCurrentWindow();
    if (!win) {
      // if the window isn't even created, just poll wait for it
      let checkTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      checkTimer.initWithCallback(waitForWindow.bind(this), 100,
          Ci.nsITimer.TYPE_ONE_SHOT);
    } else if (win.document.readyState != "complete") {
      // otherwise, wait for it to be fully loaded before proceeding
      let listener = ev => {
        // ensure that we proceed, on the top level document load event
        // (not an iframe one...)
        if (ev.target != win.document)
          return;
        win.removeEventListener("load", listener);
        waitForWindow.call(this);
      };
      win.addEventListener("load", listener, true);
    } else {
      let clickToStart;
      try {
        clickToStart = Services.prefs.getBoolPref(CLICK_TO_START_PREF);
      } catch (e) {}
      if (clickToStart && (this.appName != "B2G")) {
        let pService = Cc["@mozilla.org/embedcomp/prompt-service;1"]
            .getService(Ci.nsIPromptService);
        pService.alert(win, "", "Click to start execution of marionette tests");
      }
      this.startBrowser(win, true);
    }
  };

  let runSessionStart = function() {
    if (!Services.prefs.getBoolPref(CONTENT_LISTENER_PREF)) {
      waitForWindow.call(this);
    } else if (this.appName != "Firefox" && this.curBrowser === null) {
      // if there is a content listener, then we just wake it up
      this.addBrowser(this.getCurrentWindow());
      this.curBrowser.startSession(this.whenBrowserStarted.bind(this));
      this.mm.broadcastAsyncMessage("Marionette:restart", {});
    } else {
      throw new WebDriverError("Session already running");
    }
    this.switchToGlobalMessageManager();
  };

  if (!delayedBrowserStarted && this.appName != "B2G") {
    let self = this;
    Services.obs.addObserver(function onStart() {
      Services.obs.removeObserver(onStart, BROWSER_STARTUP_FINISHED);
      runSessionStart.call(self);
    }, BROWSER_STARTUP_FINISHED, false);
  } else {
    runSessionStart.call(this);
  }

  yield registerBrowsers;
  yield browserListening;

  resp.sessionId = this.sessionId;
  resp.value = this.sessionCapabilities;
};

/**
 * Send the current session's capabilities to the client.
 *
 * Capabilities informs the client of which WebDriver features are
 * supported by Firefox and Marionette.  They are immutable for the
 * length of the session.
 *
 * The return value is an immutable map of string keys
 * ("capabilities") to values, which may be of types boolean,
 * numerical or string.
 */
GeckoDriver.prototype.getSessionCapabilities = function(cmd, resp) {
  resp.value = this.sessionCapabilities;
};

/**
 * Update the sessionCapabilities object with the keys that have been
 * passed in when a new session is created.
 *
 * This part of the WebDriver spec is currently in flux, see
 * http://lists.w3.org/Archives/Public/public-browser-tools-testing/2014OctDec/0000.html
 *
 * This is not a public API, only available when a new session is
 * created.
 *
 * @param {Object} newCaps
 *     Key/value dictionary to overwrite session's current capabilities.
 */
GeckoDriver.prototype.setSessionCapabilities = function(newCaps) {
  const copy = (from, to={}) => {
    let errors = {};

    for (let key in from) {
      if (key === "desiredCapabilities") {
        // Keeping desired capabilities separate for now so that we can keep
        // backwards compatibility
        to = copy(from[key], to);
      } else if (key === "requiredCapabilities") {
        for (let caps in from[key]) {
          if (from[key][caps] !== this.sessionCapabilities[caps]) {
            errors[caps] = from[key][caps] + " does not equal " +
                this.sessionCapabilities[caps];
          }
        }
      }
      to[key] = from[key];
    }

    if (Object.keys(errors).length == 0)
      return to;

    throw new SessionNotCreatedError(
        `Not all requiredCapabilities could be met: ${JSON.stringify(errors)}`);
  };

  // clone, overwrite, and set
  let caps = copy(this.sessionCapabilities);
  caps = copy(newCaps, caps);
  this.sessionCapabilities = caps;
};

/**
 * Log message.  Accepts user defined log-level.
 *
 * @param {string} value
 *     Log message.
 * @param {string} level
 *     Arbitrary log level.
 */
GeckoDriver.prototype.log = function(cmd, resp) {
  this.marionetteLog.log(cmd.parameters.value, cmd.parameters.level);
};

/** Return all logged messages. */
GeckoDriver.prototype.getLogs = function(cmd, resp) {
  resp.value = this.marionetteLog.getLogs();
};

/**
 * Sets the context of the subsequent commands to be either "chrome" or
 * "content".
 *
 * @param {string} value
 *     Name of the context to be switched to.  Must be one of "chrome" or
 *     "content".
 */
GeckoDriver.prototype.setContext = function(cmd, resp) {
  let val = cmd.parameters.value;
  let ctx = Context.fromString(val);
  if (ctx === null)
    throw new WebDriverError(`Invalid context: ${val}`);
  this.context = ctx;
};

/** Gets the context of the server, either "chrome" or "content". */
GeckoDriver.prototype.getContext = function(cmd, resp) {
  resp.value = this.context.toString();
};

/**
 * Returns a chrome sandbox that can be used by the execute and
 * executeWithCallback functions.
 *
 * @param {nsIDOMWindow} win
 *     Window in which we will execute code.
 * @param {Marionette} mn
 *     Marionette test instance.
 * @param {Object} args
 *     Arguments given by client.
 * @param {boolean} sp
 *     True to enable special powers in the sandbox, false not to.
 *
 * @return {nsIXPCComponents_utils_Sandbox}
 *     Returns the sandbox.
 */
GeckoDriver.prototype.createExecuteSandbox = function(win, mn, sp) {
  let sb = new Cu.Sandbox(win,
      {sandboxPrototype: win, wantXrays: false, sandboxName: ""});
  sb.global = sb;
  sb.testUtils = utils;

  mn.exports.forEach(function(fn) {
    try {
      sb[fn] = mn[fn].bind(mn);
    } catch(e) {
      sb[fn] = mn[fn];
    }
  });

  sb.isSystemMessageListenerReady = () => systemMessageListenerReady;

  if (sp) {
    let pow = [
      "chrome://specialpowers/content/specialpowersAPI.js",
      "chrome://specialpowers/content/SpecialPowersObserverAPI.js",
      "chrome://specialpowers/content/ChromePowers.js",
    ];
    pow.map(s => loader.loadSubScript(s, sb));
  }

  return sb;
};

/**
 * Apply arguments sent from the client to the current (possibly reused)
 * execution sandbox.
 */
GeckoDriver.prototype.applyArgumentsToSandbox = function(win, sb, args) {
  sb.__marionetteParams = this.curBrowser.elementManager.convertWrappedArguments(args, win);
  sb.__namedArgs = this.curBrowser.elementManager.applyNamedArgs(args);
};

/**
 * Executes a script in the given sandbox.
 *
 * @param {Response} resp
 *     Response object given to the command calling this routine.
 * @param {nsIXPCComponents_utils_Sandbox} sandbox
 *     Sandbox in which the script will run.
 * @param {string} script
 *     Script to run.
 * @param {boolean} directInject
 *     If true, then the script will be run as is, and not as a function
 *     body (as you would do using the WebDriver spec).
 * @param {boolean} async
 *     True if the script is asynchronous.
 * @param {number} timeout
 *     When to interrupt script in milliseconds.
 */
GeckoDriver.prototype.executeScriptInSandbox = function(
    resp,
    sandbox,
    script,
    directInject,
    async,
    timeout) {
  if (directInject && async && (timeout == null || timeout == 0))
    throw new TimeoutError("Please set a timeout");

  if (this.importedScripts.exists()) {
    let stream = Cc["@mozilla.org/network/file-input-stream;1"]
        .createInstance(Ci.nsIFileInputStream);
    stream.init(this.importedScripts, -1, 0, 0);
    let data = NetUtil.readInputStreamToString(stream, stream.available());
    stream.close();
    script = data + script;
  }

  let res = Cu.evalInSandbox(script, sandbox, "1.8", "dummy file", 0);

  if (directInject && !async &&
      (res == undefined || res.passed == undefined))
    throw new WebDriverError("finish() not called");

  if (!async) {
    // It's fine to pass on and modify resp here because
    // executeScriptInSandbox is the last function to be called
    // in execute and executeWithCallback respectively.
    resp.value = this.curBrowser.elementManager.wrapValue(res);
  }
};

/**
 * Execute the given script either as a function body or directly (for
 * mochitest-like JS Marionette tests).
 *
 * If directInject is ture, it will run directly and not as a function
 * body.
 */
GeckoDriver.prototype.execute = function(cmd, resp, directInject) {
  let {inactivityTimeout,
       scriptTimeout,
       script,
       newSandbox,
       args,
       specialPowers,
       filename,
       line} = cmd.parameters;

  if (!scriptTimeout)
    scriptTimeout = this.scriptTimeout;
  if (typeof newSandbox == "undefined")
    newSandbox = true;

  if (this.context == Context.CONTENT) {
    resp.value = yield this.listener.executeScript({
      script: script,
      args: args,
      newSandbox: newSandbox,
      timeout: scriptTimeout,
      specialPowers: specialPowers,
      filename: filename,
      line: line
    });
    return;
  }

  // handle the inactivity timeout
  let that = this;
  if (inactivityTimeout) {
    let setTimer = function() {
      that.inactivityTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      if (that.inactivityTimer != null) {
        that.inactivityTimer.initWithCallback(function() {
          throw new ScriptTimeoutError("timed out due to inactivity");
        }, inactivityTimeout, Ci.nsITimer.TYPE_ONE_SHOT);
      }
    };
    setTimer();
    this.heartbeatCallback = function() {
      that.inactivityTimer.cancel();
      setTimer();
    };
  }

  let win = this.getCurrentWindow();
  if (!this.sandbox || newSandbox) {
    let marionette = new Marionette(
        this,
        win,
        "chrome",
        this.marionetteLog,
        scriptTimeout,
        this.heartbeatCallback,
        this.testName);
    this.sandbox = this.createExecuteSandbox(
        win,
        marionette,
        specialPowers);
    if (!this.sandbox)
      return;
  }
  this.applyArgumentsToSandbox(win, this.sandbox, args);

  try {
    this.sandbox.finish = () => {
      if (this.inactivityTimer != null)
        this.inactivityTimer.cancel();
      return this.sandbox.generate_results();
    };

    if (!directInject)
      script = `let func = function() { ${script} }; func.apply(null, __marionetteParams);`;
    this.executeScriptInSandbox(
        resp,
        this.sandbox,
        script,
        directInject,
        false /* async */,
        scriptTimeout);
  } catch (e) {
    throw new JavaScriptError(e, "execute_script", filename, line, script);
  }
};

/**
 * Set the timeout for asynchronous script execution.
 *
 * @param {number} ms
 *     Time in milliseconds.
 */
GeckoDriver.prototype.setScriptTimeout = function(cmd, resp) {
  let ms = parseInt(cmd.parameters.ms);
  if (isNaN(ms))
    throw new WebDriverError("Not a Number");
  this.scriptTimeout = ms;
};

/**
 * Execute pure JavaScript.  Used to execute mochitest-like Marionette
 * tests.
 */
GeckoDriver.prototype.executeJSScript = function(cmd, resp) {
  // TODO(ato): cmd.newSandbox doesn't ever exist?
  // All pure JS scripts will need to call
  // Marionette.finish() to complete the test
  if (typeof cmd.newSandbox == "undefined") {
    // If client does not send a value in newSandbox,
    // then they expect the same behaviour as WebDriver.
    cmd.newSandbox = true;
  }

  switch (this.context) {
    case Context.CHROME:
      if (cmd.parameters.async)
        yield this.executeWithCallback(cmd, resp, cmd.parameters.async);
      else
        this.execute(cmd, resp, true /* async */);
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.executeJSScript({
        script: cmd.parameters.script,
        args: cmd.parameters.args,
        newSandbox: cmd.parameters.newSandbox,
        async: cmd.parameters.async,
        timeout: cmd.parameters.scriptTimeout ?
            cmd.parameters.scriptTimeout : this.scriptTimeout,
        inactivityTimeout: cmd.parameters.inactivityTimeout,
        specialPowers: cmd.parameters.specialPowers,
        filename: cmd.parameters.filename,
        line: cmd.parameters.line,
      });
      break;
 }
};

/**
 * This function is used by executeAsync and executeJSScript to execute
 * a script in a sandbox.
 *
 * For executeJSScript, it will return a message only when the finish()
 * method is called.
 *
 * For executeAsync, it will return a response when
 * {@code marionetteScriptFinished} (equivalent to
 * {@code arguments[arguments.length-1]}) function is called,
 * or if it times out.
 *
 * If directInject is true, it will be run directly and not as a
 * function body.
 */
GeckoDriver.prototype.executeWithCallback = function(cmd, resp, directInject) {
  let {script,
      args,
      newSandbox,
      inactivityTimeout,
      scriptTimeout,
      specialPowers,
      filename,
      line} = cmd.parameters;

  if (!scriptTimeout)
    scriptTimeout = this.scriptTimeout;
  if (typeof newSandbox == "undefined")
    newSandbox = true;

  if (this.context == Context.CONTENT) {
    resp.value = yield this.listener.executeAsyncScript({
      script: script,
      args: args,
      id: cmd.id,
      newSandbox: newSandbox,
      timeout: scriptTimeout,
      inactivityTimeout: inactivityTimeout,
      specialPowers: specialPowers,
      filename: filename,
      line: line
    });
    return;
  }

  // handle the inactivity timeout
  let that = this;
  if (inactivityTimeout) {
    this.inactivityTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    if (this.inactivityTimer != null) {
      this.inactivityTimer.initWithCallback(function() {
       chromeAsyncReturnFunc(new ScriptTimeoutError("timed out due to inactivity"));
      }, inactivityTimeout, Ci.nsITimer.TYPE_ONE_SHOT);
    }
    this.heartbeatCallback = function resetInactivityTimer() {
      that.inactivityTimer.cancel();
      that.inactivityTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      if (that.inactivityTimer != null) {
        that.inactivityTimer.initWithCallback(function() {
          chromeAsyncReturnFunc(new ScriptTimeoutError("timed out due to inactivity"));
        }, inactivityTimeout, Ci.nsITimer.TYPE_ONE_SHOT);
      }
    };
  }

  let win = this.getCurrentWindow();
  let origOnError = win.onerror;
  that.timeout = scriptTimeout;

  let res = yield new Promise(function(resolve, reject) {
    let chromeAsyncReturnFunc = function(val) {
      if (that.emulator.cbs.length > 0) {
        that.emulator.cbs = [];
        throw new WebDriverError("Emulator callback still pending when finish() called");
      }

      if (cmd.id == that.sandbox.command_id) {
        if (that.timer != null) {
          that.timer.cancel();
          that.timer = null;
        }

        win.onerror = origOnError;

        if (error.isError(val))
          reject(val);
        else
          resolve(val);
      }

      if (that.inactivityTimer != null)
        that.inactivityTimer.cancel();
    };

    let chromeAsyncFinish = function() {
      let res = that.sandbox.generate_results();
      chromeAsyncReturnFunc(res);
    };

    let chromeAsyncError = function(e, func, file, line, script) {
      let err = new JavaScriptError(e, func, file, line, script);
      chromeAsyncReturnFunc(err);
    };

    if (!this.sandbox || newSandbox) {
      let marionette = new Marionette(
          this,
          win,
          "chrome",
          this.marionetteLog,
          scriptTimeout,
          this.heartbeatCallback,
          this.testName);
      this.sandbox = this.createExecuteSandbox(win, marionette, specialPowers);
      if (!this.sandbox)
        return;
    }
    this.sandbox.command_id = cmd.id;
    this.sandbox.runEmulatorCmd = (cmd, cb) => {
      let ecb = new EmulatorCallback();
      ecb.onresult = cb;
      ecb.onerror = chromeAsyncError;
      this.emulator.pushCallback(ecb);
      this.emulator.send({emulator_cmd: cmd, id: ecb.id});
    };
    this.sandbox.runEmulatorShell = (args, cb) => {
      let ecb = new EmulatorCallback();
      ecb.onresult = cb;
      ecb.onerror = chromeAsyncError;
      this.emulator.pushCallback(ecb);
      this.emulator.send({emulator_shell: args, id: ecb.id});
    };
    this.applyArgumentsToSandbox(win, this.sandbox, args);

    // NB: win.onerror is not hooked by default due to the inability to
    // differentiate content exceptions from chrome exceptions. See bug
    // 1128760 for more details. A debug_script flag can be set to
    // reenable onerror hooking to help debug test scripts.
    if (cmd.parameters.debug_script) {
      win.onerror = function(msg, url, line) {
        let err = new JavaScriptError(`${msg} at: ${url} line: ${line}`);
        chromeAsyncReturnFunc(err);
        return true;
      };
    }

    try {
      this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      if (this.timer != null) {
        this.timer.initWithCallback(function() {
          chromeAsyncReturnFunc(new ScriptTimeoutError("timed out"));
        }, that.timeout, Ci.nsITimer.TYPE_ONE_SHOT);
      }

      this.sandbox.returnFunc = chromeAsyncReturnFunc;
      this.sandbox.finish = chromeAsyncFinish;

      if (!directInject) {
        script =  "__marionetteParams.push(returnFunc);" +
            "let marionetteScriptFinished = returnFunc;" +
            "let __marionetteFunc = function() {" + script + "};" +
            "__marionetteFunc.apply(null, __marionetteParams);";
      }

      this.executeScriptInSandbox(
          resp,
          this.sandbox,
          script,
          directInject,
          true /* async */,
          scriptTimeout);
    } catch (e) {
      chromeAsyncError(e, "execute_async_script", filename, line, script);
    }
  }.bind(this));

  resp.value = that.curBrowser.elementManager.wrapValue(res);
};

/**
 * Navigate to to given URL.
 *
 * This will follow redirects issued by the server.  When the method
 * returns is based on the page load strategy that the user has
 * selected.
 *
 * Documents that contain a META tag with the "http-equiv" attribute
 * set to "refresh" will return if the timeout is greater than 1
 * second and the other criteria for determining whether a page is
 * loaded are met.  When the refresh period is 1 second or less and
 * the page load strategy is "normal" or "conservative", it will
 * wait for the page to complete loading before returning.
 *
 * If any modal dialog box, such as those opened on
 * window.onbeforeunload or window.alert, is opened at any point in
 * the page load, it will return immediately.
 *
 * If a 401 response is seen by the browser, it will return
 * immediately.  That is, if BASIC, DIGEST, NTLM or similar
 * authentication is required, the page load is assumed to be
 * complete.  This does not include FORM-based authentication.
 *
 * @param {string} url
 *     URL to navigate to.
 */
GeckoDriver.prototype.get = function(cmd, resp) {
  let url = cmd.parameters.url;

  switch (this.context) {
    case Context.CONTENT:
      // If a remoteness update interrupts our page load, this will never return
      // We need to re-issue this request to correctly poll for readyState and
      // send errors.
      this.curBrowser.pendingCommands.push(() => {
        cmd.parameters.command_id = this.listener.curCmdId;
        this.mm.broadcastAsyncMessage(
            "Marionette:pollForReadyState" + this.curBrowser.curFrameId,
            cmd.parameters);
      });
      yield this.listener.get({url: url, pageTimeout: this.pageTimeout});
      break;

    case Context.CHROME:
      // At least on desktop, navigating in chrome scope does not
      // correspond to something a user can do, and leaves marionette
      // and the browser in an unusable state. Return a generic error insted.
      // TODO: Error codes need to be refined as a part of bug 1100545 and
      // bug 945729.
      if (this.appName == "Firefox")
        throw new UnknownError("Cannot navigate in chrome context");

      this.getCurrentWindow().location.href = url;
      yield this.pageLoadPromise();
      break;
  }
};

GeckoDriver.prototype.pageLoadPromise = function() {
  let win = this.getCurrentWindow();
  let timeout = this.pageTimeout;
  let checkTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  let start = new Date().getTime();
  let end = null;

  return new Promise((resolve) => {
    let checkLoad = function() {
      end = new Date().getTime();
      let elapse = end - start;
      if (timeout == null || elapse <= timeout) {
        if (win.document.readyState == "complete")
          resolve();
        else
          checkTimer.initWithCallback(checkLoad, 100, Ci.nsITimer.TYPE_ONE_SHOT);
      } else {
        throw new UnknownError("Error loading page");
      }
    };
    checkTimer.initWithCallback(checkLoad, 100, Ci.nsITimer.TYPE_ONE_SHOT);
  });
};

/**
 * Get a string representing the current URL.
 *
 * On Desktop this returns a string representation of the URL of the
 * current top level browsing context.  This is equivalent to
 * document.location.href.
 *
 * When in the context of the chrome, this returns the canonical URL
 * of the current resource.
 */
GeckoDriver.prototype.getCurrentUrl = function(cmd, resp) {
  switch (this.context) {
    case Context.CHROME:
      resp.value = this.getCurrentWindow().location.href;
      break;

    case Context.CONTENT:
      let isB2G = this.appName == "B2G";
      resp.value = yield this.listener.getCurrentUrl({isB2G: isB2G});
      break;
  }
};

/** Gets the current title of the window. */
GeckoDriver.prototype.getTitle = function(cmd, resp) {
  switch (this.context) {
    case Context.CHROME:
      let win = this.getCurrentWindow();
      resp.value = win.document.documentElement.getAttribute("title");
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.getTitle();
      break;
  }
};

/** Gets the current type of the window. */
GeckoDriver.prototype.getWindowType = function(cmd, resp) {
  let win = this.getCurrentWindow();
  resp.value = win.document.documentElement.getAttribute("windowtype");
};

/** Gets the page source of the content document. */
GeckoDriver.prototype.getPageSource = function(cmd, resp) {
  switch (this.context) {
    case Context.CHROME:
      let win = this.getCurrentWindow();
      let s = new win.XMLSerializer();
      resp.value = s.serializeToString(win.document);
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.getPageSource();
      break;
  }
};

/** Go back in history. */
GeckoDriver.prototype.goBack = function(cmd, resp) {
  yield this.listener.goBack();
};

/** Go forward in history. */
GeckoDriver.prototype.goForward = function(cmd, resp) {
  yield this.listener.goForward();
};

/** Refresh the page. */
GeckoDriver.prototype.refresh = function(cmd, resp) {
  yield this.listener.refresh();
};

/**
 * Get the current window's handle. On desktop this typically corresponds
 * to the currently selected tab.
 *
 * Return an opaque server-assigned identifier to this window that
 * uniquely identifies it within this Marionette instance.  This can
 * be used to switch to this window at a later point.
 *
 * @return {string}
 *     Unique window handle.
 */
GeckoDriver.prototype.getWindowHandle = function(cmd, resp) {
  // curFrameId always holds the current tab.
  if (this.curBrowser.curFrameId && this.appName != "B2G") {
    resp.value = this.curBrowser.curFrameId;
    return;
  }

  for (let i in this.browsers) {
    if (this.curBrowser == this.browsers[i]) {
      resp.value = i;
      return;
    }
  }
};

/**
 * Forces an update for the given browser's id.
 */
GeckoDriver.prototype.updateIdForBrowser = function (browser, newId) {
  this._browserIds.set(browser.permanentKey, newId);
};

/**
 * Retrieves a listener id for the given xul browser element. In case
 * the browser is not known, an attempt is made to retrieve the id from
 * a CPOW, and null is returned if this fails.
 */
GeckoDriver.prototype.getIdForBrowser = function getIdForBrowser(browser) {
  if (browser === null) {
    return null;
  }
  let permKey = browser.permanentKey;
  if (this._browserIds.has(permKey)) {
    return this._browserIds.get(permKey);
  }

  let winId = browser.outerWindowID;
  if (winId) {
    winId += "";
    this._browserIds.set(permKey, winId);
    return winId;
  }
  return null;
},

/**
 * Get a list of top-level browsing contexts.  On desktop this typically
 * corresponds to the set of open tabs.
 *
 * Each window handle is assigned by the server and is guaranteed unique,
 * however the return array does not have a specified ordering.
 *
 * @return {Array.<string>}
 *     Unique window handles.
 */
GeckoDriver.prototype.getWindowHandles = function(cmd, resp) {
  let rv = [];
  let winEn = this.getWinEnumerator();
  while (winEn.hasMoreElements()) {
    let win = winEn.getNext();
    if (win.gBrowser && this.appName != "B2G") {
      let tabbrowser = win.gBrowser;
      for (let i = 0; i < tabbrowser.browsers.length; ++i) {
        let winId = this.getIdForBrowser(tabbrowser.getBrowserAtIndex(i));
        if (winId !== null) {
          rv.push(winId);
        }
      }
    } else {
      // XUL Windows, at least, do not have gBrowser
      let winId = win.QueryInterface(Ci.nsIInterfaceRequestor)
          .getInterface(Ci.nsIDOMWindowUtils)
          .outerWindowID;
      winId += (this.appName == "B2G") ? "-b2g" : "";
      rv.push(winId);
    }
  }
  resp.value = rv;
};

/**
 * Get the current window's handle.  This corresponds to a window that
 * may itself contain tabs.
 *
 * Return an opaque server-assigned identifier to this window that
 * uniquely identifies it within this Marionette instance.  This can
 * be used to switch to this window at a later point.
 *
 * @return {string}
 *     Unique window handle.
 */
GeckoDriver.prototype.getChromeWindowHandle = function(cmd, resp) {
  for (let i in this.browsers) {
    if (this.curBrowser == this.browsers[i]) {
      resp.value = i;
      return;
    }
  }
};

/**
 * Returns identifiers for each open chrome window for tests interested in
 * managing a set of chrome windows and tabs separately.
 *
 * @return {Array.<string>}
 *     Unique window handles.
 */
GeckoDriver.prototype.getChromeWindowHandles = function(cmd, resp) {
  let rv = [];
  let winEn = this.getWinEnumerator();
  while (winEn.hasMoreElements()) {
    let foundWin = winEn.getNext();
    let winId = foundWin.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDOMWindowUtils)
        .outerWindowID;
    winId = winId + ((this.appName == "B2G") ? "-b2g" : "");
    rv.push(winId);
  }
  resp.value = rv;
};

/**
 * Get the current window position.
 *
 * @return {Object.<string, number>}
 *     Object with x and y coordinates.
 */
GeckoDriver.prototype.getWindowPosition = function(cmd, resp) {
  let win = this.getCurrentWindow();
  resp.value = {x: win.screenX, y: win.screenY};
};

/**
 * Set the window position of the browser on the OS Window Manager
 *
 * @param {number} x
 *     X coordinate of the top/left of the window that it will be
 *     moved to.
 * @param {number} y
 *     Y coordinate of the top/left of the window that it will be
 *     moved to.
 */
GeckoDriver.prototype.setWindowPosition = function(cmd, resp) {
  if (this.appName != "Firefox")
    throw new WebDriverError("Unable to set the window position on mobile");

  let x = parseInt(cmd.parameters.x);
  let y  = parseInt(cmd.parameters.y);
  if (isNaN(x) || isNaN(y))
    throw new UnknownError("x and y arguments should be integers");

  let win = this.getCurrentWindow();
  win.moveTo(x, y);
};

/**
 * Switch current top-level browsing context by name or server-assigned ID.
 * Searches for windows by name, then ID.  Content windows take precedence.
 *
 * @param {string} name
 *     Target name or ID of the window to switch to.
 */
GeckoDriver.prototype.switchToWindow = function(cmd, resp) {
  let switchTo = cmd.parameters.name;
  let isB2G = this.appName == "B2G";
  let found;

  let getOuterWindowId = function(win) {
    let rv = win.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDOMWindowUtils)
        .outerWindowID;
    rv += isB2G ? "-b2g" : "";
    return rv;
  };

  let byNameOrId = function(name, outerId, contentWindowId) {
    return switchTo == name ||
        switchTo == contentWindowId ||
        switchTo == outerId;
  };

  let winEn = this.getWinEnumerator();
  while (winEn.hasMoreElements()) {
    let win = winEn.getNext();
    let outerId = getOuterWindowId(win);

    if (win.gBrowser && !isB2G) {
      let tabbrowser = win.gBrowser;
      for (let i = 0; i < tabbrowser.browsers.length; ++i) {
        let browser = tabbrowser.getBrowserAtIndex(i);
        let contentWindowId = this.getIdForBrowser(browser);
        if (byNameOrId(win.name, contentWindowId, outerId)) {
          found = {
            win: win,
            outerId: outerId,
            tabIndex: i,
            contentId: contentWindowId
          };
          break;
        }
      }
    } else {
      if (byNameOrId(win.name, outerId)) {
        found = {win: win, outerId: outerId};
        break;
      }
    }
  }

  if (found) {
    // As in content, switching to a new window invalidates a sandbox
    // for reuse.
    this.sandbox = null;

    // Initialise Marionette if browser has not been seen before,
    // otherwise switch to known browser and activate the tab if it's a
    // content browser.
    if (!(found.outerId in this.browsers)) {
      let registerBrowsers, browserListening;
      if (found.contentId) {
        registerBrowsers = this.registerPromise();
        browserListening = this.listeningPromise();
      }

      this.startBrowser(found.win, false /* isNewSession */);

      if (registerBrowsers && browserListening) {
        yield registerBrowsers;
        yield browserListening;
      }
    } else {
      utils.window = found.win;
      this.curBrowser = this.browsers[found.outerId];

      if (found.contentId) {
        this.curBrowser.switchToTab(found.tabIndex);
      }
    }
  } else {
    throw new NoSuchWindowError(`Unable to locate window: ${switchTo}`);
  }
};

GeckoDriver.prototype.getActiveFrame = function(cmd, resp) {
  switch (this.context) {
    case Context.CHROME:
      // no frame means top-level
      resp.value = null;
      if (this.curFrame)
        resp.value = this.curBrowser.elementManager
            .addToKnownElements(this.curFrame.frameElement);
      break;

    case Context.CONTENT:
      resp.value = this.currentFrameElement;
      break;
  }
};

/**
 * Switch to a given frame within the current window.
 *
 * @param {Object} element
 *     A web element reference to the element to switch to.
 * @param {(string|number)} id
 *     If element is not defined, then this holds either the id, name,
 *     or index of the frame to switch to.
 */
GeckoDriver.prototype.switchToFrame = function(cmd, resp) {
  let checkTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  let curWindow = this.getCurrentWindow();

  let checkLoad = function() {
    let errorRegex = /about:.+(error)|(blocked)\?/;
    let curWindow = this.getCurrentWindow();
    if (curWindow.document.readyState == "complete") {
      return;
    } else if (curWindow.document.readyState == "interactive" &&
        errorRegex.exec(curWindow.document.baseURI)) {
      throw new UnknownError("Error loading page");
    }

    checkTimer.initWithCallback(checkLoad.bind(this), 100, Ci.nsITimer.TYPE_ONE_SHOT);
  };

  if (this.context == Context.CHROME) {
    let foundFrame = null;
    if ((cmd.parameters.id == null) && (cmd.parameters.element == null)) {
      this.curFrame = null;
      if (cmd.parameters.focus) {
        this.mainFrame.focus();
      }
      checkTimer.initWithCallback(checkLoad.bind(this), 100, Ci.nsITimer.TYPE_ONE_SHOT);
      return;
    }
    if (cmd.parameters.element != undefined) {
      if (this.curBrowser.elementManager.seenItems[cmd.parameters.element]) {
        // HTMLIFrameElement
        let wantedFrame = this.curBrowser.elementManager
            .getKnownElement(cmd.parameters.element, curWindow);
        // Deal with an embedded xul:browser case
        if (wantedFrame.tagName == "xul:browser" || wantedFrame.tagName == "browser") {
          curWindow = wantedFrame.contentWindow;
          this.curFrame = curWindow;
          if (cmd.parameters.focus) {
            this.curFrame.focus();
          }
          checkTimer.initWithCallback(checkLoad.bind(this), 100, Ci.nsITimer.TYPE_ONE_SHOT);
          return;
        }
        // else, assume iframe
        let frames = curWindow.document.getElementsByTagName("iframe");
        let numFrames = frames.length;
        for (let i = 0; i < numFrames; i++) {
          if (XPCNativeWrapper(frames[i]) == XPCNativeWrapper(wantedFrame)) {
            curWindow = frames[i].contentWindow;
            this.curFrame = curWindow;
            if (cmd.parameters.focus) {
              this.curFrame.focus();
            }
            checkTimer.initWithCallback(checkLoad.bind(this), 100, Ci.nsITimer.TYPE_ONE_SHOT);
            return;
        }
      }
    }
  }
  switch(typeof(cmd.parameters.id)) {
    case "string" :
      let foundById = null;
      let frames = curWindow.document.getElementsByTagName("iframe");
      let numFrames = frames.length;
      for (let i = 0; i < numFrames; i++) {
        //give precedence to name
        let frame = frames[i];
        if (frame.getAttribute("name") == cmd.parameters.id) {
          foundFrame = i;
          curWindow = frame.contentWindow;
          break;
        } else if ((foundById == null) && (frame.id == cmd.parameters.id)) {
          foundById = i;
        }
      }
      if ((foundFrame == null) && (foundById != null)) {
        foundFrame = foundById;
        curWindow = frames[foundById].contentWindow;
      }
      break;
    case "number":
      if (curWindow.frames[cmd.parameters.id] != undefined) {
        foundFrame = cmd.parameters.id;
        curWindow = curWindow.frames[foundFrame].frameElement.contentWindow;
      }
      break;
    }
    if (foundFrame != null) {
      this.curFrame = curWindow;
      if (cmd.parameters.focus) {
        this.curFrame.focus();
      }
      checkTimer.initWithCallback(checkLoad.bind(this), 100, Ci.nsITimer.TYPE_ONE_SHOT);
    } else {
      throw new NoSuchFrameError(
          `Unable to locate frame: ${cmd.parameters.id}`);
    }
  }
  else {
    if ((!cmd.parameters.id) && (!cmd.parameters.element) &&
        (this.curBrowser.frameManager.currentRemoteFrame !== null)) {
      // We're currently using a ChromeMessageSender for a remote frame, so this
      // request indicates we need to switch back to the top-level (parent) frame.
      // We'll first switch to the parent's (global) ChromeMessageBroadcaster, so
      // we send the message to the right listener.
      this.switchToGlobalMessageManager();
    }
    cmd.command_id = cmd.id;

    let res = yield this.listener.switchToFrame(cmd.parameters);
    if (res) {
      let {win: winId, frame: frameId} = res;
      this.mm = this.curBrowser.frameManager.getFrameMM(winId, frameId);

      let registerBrowsers = this.registerPromise();
      let browserListening = this.listeningPromise();

      this.oopFrameId =
          this.curBrowser.frameManager.switchToFrame(winId, frameId);

      yield registerBrowsers;
      yield browserListening;
    }
  }
};

/**
 * Set timeout for searching for elements.
 *
 * @param {number} ms
 *     Search timeout in milliseconds.
 */
GeckoDriver.prototype.setSearchTimeout = function(cmd, resp) {
  let ms = parseInt(cmd.parameters.ms);
  if (isNaN(ms))
    throw new WebDriverError("Not a Number");
  this.searchTimeout = ms;
};

/**
 * Set timeout for page loading, searching, and scripts.
 *
 * @param {string} type
 *     Type of timeout.
 * @param {number} ms
 *     Timeout in milliseconds.
 */
GeckoDriver.prototype.timeouts = function(cmd, resp) {
  let typ = cmd.parameters.type;
  let ms = parseInt(cmd.parameters.ms);
  if (isNaN(ms))
    throw new WebDriverError("Not a Number");

  switch (typ) {
    case "implicit":
      this.setSearchTimeout(cmd, resp);
      break;

    case "script":
      this.setScriptTimeout(cmd, resp);
      break;

    default:
      this.pageTimeout = ms;
      break;
  }
};

/** Single tap. */
GeckoDriver.prototype.singleTap = function(cmd, resp) {
  let {id, x, y} = cmd.parameters;

  switch (this.context) {
    case Context.CHROME:
      throw new WebDriverError("Command 'singleTap' is not available in chrome context");

    case Context.CONTENT:
      this.addFrameCloseListener("tap");
      yield this.listener.singleTap({id: id, corx: x, cory: y});
      break;
  }
};

/**
 * An action chain.
 *
 * @param {Object} value
 *     A nested array where the inner array represents each event,
 *     and the outer array represents a collection of events.
 *
 * @return {number}
 *     Last touch ID.
 */
GeckoDriver.prototype.actionChain = function(cmd, resp) {
  switch (this.context) {
    case Context.CHROME:
      throw new WebDriverError("Command 'actionChain' is not available in chrome context");

    case Context.CONTENT:
      this.addFrameCloseListener("action chain");
      resp.value = yield this.listener.actionChain(
        {chain: cmd.parameters.chain, nextId: cmd.parameters.nextId});
      break;
  }
};

/**
 * A multi-action chain.
 *
 * @param {Object} value
 *     A nested array where the inner array represents eache vent,
 *     the middle array represents a collection of events for each
 *     finger, and the outer array represents all fingers.
 */
GeckoDriver.prototype.multiAction = function(cmd, resp) {
  switch (this.context) {
  case Context.CHROME:
    throw new WebDriverError("Command 'multiAction' is not available in chrome context");

  case Context.CONTENT:
    this.addFrameCloseListener("multi action chain");
    yield this.listener.multiAction(
        {value: value, maxlen: max_len} = cmd.parameters);
    break;
  }
};

/**
 * Find an element using the indicated search strategy.
 *
 * @param {string} using
 *     Indicates which search method to use.
 * @param {string} value
 *     Value the client is looking for.
 */
GeckoDriver.prototype.findElement = function(cmd, resp) {
  switch (this.context) {
    case Context.CHROME:
      resp.value = yield new Promise((resolve, reject) => {
        let win = this.getCurrentWindow();
        this.curBrowser.elementManager.find(
            win,
            cmd.parameters,
            this.searchTimeout,
            false /* all */,
            resolve,
            reject);
      }).then(null, e => { throw e; });
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.findElementContent({
        value: cmd.parameters.value,
        using: cmd.parameters.using,
        element: cmd.parameters.element,
        searchTimeout: this.searchTimeout});
      break;
  }
};

/**
 * Find element using the indicated search strategy starting from a
 * known element.  Used for WebDriver Compatibility only.
 *
 * @param {string} using
 *     Indicates which search method to use.
 * @param {string} value
 *     Value the client is looking for.
 * @param {string} id
 *     Value of the element to start from.
 */
GeckoDriver.prototype.findChildElement = function(cmd, resp) {
  resp.value = yield this.listener.findElementContent({
    value: cmd.parameters.value,
    using: cmd.parameters.using,
    element: cmd.parameters.id,
    searchTimeout: this.searchTimeout});
};

/**
 * Find elements using the indicated search strategy.
 *
 * @param {string} using
 *     Indicates which search method to use.
 * @param {string} value
 *     Value the client is looking for.
 */
GeckoDriver.prototype.findElements = function(cmd, resp) {
  switch (this.context) {
    case Context.CHROME:
      resp.value = yield new Promise((resolve, reject) => {
        let win = this.getCurrentWindow();
        this.curBrowser.elementManager.find(
            win,
            cmd.parameters,
            this.searchTimeout,
            true /* all */,
            resolve,
            reject);
      }).then(null, e => { throw new NoSuchElementError(e.message); });
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.findElementsContent({
        value: cmd.parameters.value,
        using: cmd.parameters.using,
        element: cmd.parameters.element,
        searchTimeout: this.searchTimeout});
      break;
  }
};

/**
 * Find elements using the indicated search strategy starting from a
 * known element.  Used for WebDriver Compatibility only.
 *
 * @param {string} using
 *     Indicates which search method to use.
 * @param {string} value
 *     Value the client is looking for.
 * @param {string} id
 *     Value of the element to start from.
 */
GeckoDriver.prototype.findChildElements = function(cmd, resp) {
  resp.value = yield this.listener.findElementsContent({
    value: cmd.parameters.value,
    using: cmd.parameters.using,
    element: cmd.parameters.id,
    searchTimeout: this.searchTimeout});
};

/** Return the active element on the page. */
GeckoDriver.prototype.getActiveElement = function(cmd, resp) {
  resp.value = yield this.listener.getActiveElement();
};

/**
 * Send click event to element.
 *
 * @param {string} id
 *     Reference ID to the element that will be clicked.
 */
GeckoDriver.prototype.clickElement = function(cmd, resp) {
  let id = cmd.parameters.id;

  switch (this.context) {
    case Context.CHROME:
      // click atom fails, fall back to click() action
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      el.click();
      break;

    case Context.CONTENT:
      // We need to protect against the click causing an OOP frame to close.
      // This fires the mozbrowserclose event when it closes so we need to
      // listen for it and then just send an error back. The person making the
      // call should be aware something isnt right and handle accordingly
      this.addFrameCloseListener("click");
      yield this.listener.clickElement({id: id});
      break;
  }
};

/**
 * Get a given attribute of an element.
 *
 * @param {string} id
 *     Reference ID to the element that will be inspected.
 * @param {string} name
 *     Name of the attribute to retrieve.
 */
GeckoDriver.prototype.getElementAttribute = function(cmd, resp) {
  let {id, name} = cmd.parameters;

  switch (this.context) {
    case Context.CHROME:
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      resp.value = utils.getElementAttribute(el, name);
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.getElementAttribute({id: id, name: name});
      break;
  }
};

/**
 * Get the text of an element, if any.  Includes the text of all child
 * elements.
 *
 * @param {string} id
 *     Reference ID to the element that will be inspected.
 */
GeckoDriver.prototype.getElementText = function(cmd, resp) {
  let id = cmd.parameters.id;

  switch (this.context) {
    case Context.CHROME:
      // for chrome, we look at text nodes, and any node with a "label" field
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      let lines = [];
      this.getVisibleText(el, lines);
      resp.value = lines.join("\n");
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.getElementText({id: id});
      break;
  }
};

/**
 * Get the tag name of the element.
 *
 * @param {string} id
 *     Reference ID to the element that will be inspected.
 */
GeckoDriver.prototype.getElementTagName = function(cmd, resp) {
  let id = cmd.parameters.id;

  switch (this.context) {
    case Context.CHROME:
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      resp.value = el.tagName.toLowerCase();
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.getElementTagName({id: id});
      break;
  }
};

/**
 * Check if element is displayed.
 *
 * @param {string} id
 *     Reference ID to the element that will be inspected.
 */
GeckoDriver.prototype.isElementDisplayed = function(cmd, resp) {
  let id = cmd.parameters.id;

  switch (this.context) {
    case Context.CHROME:
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      resp.value = utils.isElementDisplayed(el);
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.isElementDisplayed({id: id});
      break;
  }
};

/**
 * Return the property of the computed style of an element.
 *
 * @param {string} id
 *     Reference ID to the element that will be checked.
 * @param {string} propertyName
 *     CSS rule that is being requested.
 */
GeckoDriver.prototype.getElementValueOfCssProperty = function(cmd, resp) {
  let {id, propertyName: prop} = cmd.parameters;

  switch (this.context) {
    case Context.CHROME:
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      let sty = win.document.defaultView.getComputedStyle(el, null);
      resp.value = sty.getPropertyValue(prop);
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.getElementValueOfCssProperty(
          {id: id, propertyName: prop});
      break;
  }
};

/**
 * Submit a form on a content page by either using form or element in
 * a form.
 *
 * @param {string} id
 *     Reference to the elemen that will be checked.
 */
GeckoDriver.prototype.submitElement = function(cmd, resp) {
  switch (this.context) {
    case Context.CHROME:
      throw new WebDriverError(
          "Command 'submitElement' is not available in chrome context");

    case Context.CONTENT:
      yield this.listener.submitElement({id: cmd.parameters.id});
      break;
  }
};

/**
 * Check if element is enabled.
 *
 * @param {string} id
 *     Reference ID to the element that will be checked.
 */
GeckoDriver.prototype.isElementEnabled = function(cmd, resp) {
  let id = cmd.parameters.id;

  switch (this.context) {
    case Context.CHROME:
      // Selenium atom doesn't quite work here
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      resp.value = !(!!el.disabled);
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.isElementEnabled({id: id});
      break;
  }
},

/**
 * Check if element is selected.
 *
 * @param {string} id
 *     Reference ID to the element that will be checked.
 */
GeckoDriver.prototype.isElementSelected = function(cmd, resp) {
  let id = cmd.parameters.id;

  switch (this.context) {
    case Context.CHROME:
      // Selenium atom doesn't quite work here
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      if (typeof el.checked != "undefined") {
        resp.value = !!el.checked;
      } else if (typeof el.selected != "undefined") {
        resp.value = !!el.selected;
      } else {
        resp.value = true;
      }
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.isElementSelected({id: id});
      break;
  }
};

GeckoDriver.prototype.getElementSize = function(cmd, resp) {
  let id = cmd.parameters.id;

  switch (this.context) {
    case Context.CHROME:
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      let rect = el.getBoundingClientRect();
      resp.value = {width: rect.width, height: rect.height};
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.getElementSize({id: id});
      break;
  }
};

GeckoDriver.prototype.getElementRect = function(cmd, resp) {
  let id = cmd.parameters.id;

  switch (this.context) {
    case Context.CHROME:
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      let rect = el.getBoundingClientRect();
      resp.value = {
        x: rect.x + win.pageXOffset,
        y: rect.y + win.pageYOffset,
        width: rect.width,
        height: rect.height
      };
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.getElementRect({id: id});
      break;
  }
};

/**
 * Send key presses to element after focusing on it.
 *
 * @param {string} id
 *     Reference ID to the element that will be checked.
 * @param {string} value
 *     Value to send to the element.
 */
GeckoDriver.prototype.sendKeysToElement = function(cmd, resp) {
  let {id, value} = cmd.parameters;

  switch (this.context) {
    case Context.CHROME:
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      utils.sendKeysToElement(
          win,
          el,
          value,
          () => {},
          e => { throw e; },
          cmd.id,
          true /* ignore visibility check */);
      break;

    case Context.CONTENT:
      yield this.listener.sendKeysToElement({id: id, value: value});
      break;
  }
};

/** Sets the test name.  The test name is used for logging purposes. */
GeckoDriver.prototype.setTestName = function(cmd, resp) {
  let val = cmd.parameters.value;
  this.testName = val;
  yield this.listener.setTestName({value: val});
};

/**
 * Clear the text of an element.
 *
 * @param {string} id
 *     Reference ID to the element that will be cleared.
 */
GeckoDriver.prototype.clearElement = function(cmd, resp) {
  let id = cmd.parameters.id;

  switch (this.context) {
    case Context.CHROME:
      // the selenium atom doesn't work here
      let win = this.getCurrentWindow();
      let el = this.curBrowser.elementManager.getKnownElement(id, win);
      if (el.nodeName == "textbox") {
        el.value = "";
      } else if (el.nodeName == "checkbox") {
        el.checked = false;
      }
      break;

    case Context.CONTENT:
      yield this.listener.clearElement({id: id});
      break;
  }
};

/**
 * Get an element's location on the page.
 *
 * The returned point will contain the x and y coordinates of the
 * top left-hand corner of the given element.  The point (0,0)
 * refers to the upper-left corner of the document.
 *
 * @return {Object.<string, number>}
 *     A point containing X and Y coordinates as properties.
 */
GeckoDriver.prototype.getElementLocation = function(cmd, resp) {
  resp.value = yield this.listener.getElementLocation(
      {id: cmd.parameters.id});
};

/** Add a cookie to the document. */
GeckoDriver.prototype.addCookie = function(cmd, resp) {
  yield this.listener.addCookie({cookie: cmd.parameters.cookie});
};

/**
 * Get all the cookies for the current domain.
 *
 * This is the equivalent of calling {@code document.cookie} and parsing
 * the result.
 */
GeckoDriver.prototype.getCookies = function(cmd, resp) {
  resp.value = yield this.listener.getCookies();
};

/** Delete all cookies that are visible to a document. */
GeckoDriver.prototype.deleteAllCookies = function(cmd, resp) {
  yield this.listener.deleteAllCookies();
};

/** Delete a cookie by name. */
GeckoDriver.prototype.deleteCookie = function(cmd, resp) {
  yield this.listener.deleteCookie({name: cmd.parameters.name});
};

/**
 * Close the current window, ending the session if it's the last
 * window currently open.
 *
 * On B2G this method is a noop and will return immediately.
 */
GeckoDriver.prototype.close = function(cmd, resp) {
  // can't close windows on B2G
  if (this.appName == "B2G")
    return;

  let nwins = 0;
  let winEn = this.getWinEnumerator();
  while (winEn.hasMoreElements()) {
    let win = winEn.getNext();

    // count both windows and tabs
    if (win.gBrowser)
      nwins += win.gBrowser.browsers.length;
    else
      nwins++;
  }

  // if there is only 1 window left, delete the session
  if (nwins == 1) {
    this.sessionTearDown();
    return;
  }

  try {
    if (this.mm != globalMessageManager)
      this.mm.removeDelayedFrameScript(FRAME_SCRIPT);

    if (this.curBrowser.tab)
      this.curBrowser.closeTab();
    else
      this.getCurrentWindow().close();
  } catch (e) {
    throw new UnknownError(`Could not close window: ${e.message}`);
  }
};

/**
 * Close the currently selected chrome window, ending the session if it's the last
 * window currently open.
 *
 * On B2G this method is a noop and will return immediately.
 */
GeckoDriver.prototype.closeChromeWindow = function(cmd, resp) {
  // can't close windows on B2G
  if (this.appName == "B2G")
    return;

  // Get the total number of windows
  let nwins = 0;
  let winEn = this.getWinEnumerator();
  while (winEn.hasMoreElements()) {
    nwins++;
    winEn.getNext();
  }

  // if there is only 1 window left, delete the session
  if (nwins == 1) {
    this.sessionTearDown();
    return;
  }

  try {
    this.mm.removeDelayedFrameScript(FRAME_SCRIPT);
    this.getCurrentWindow().close();
  } catch (e) {
    throw new UnknownError(`Could not close window: ${e.message}`);
  }
};

/**
 * Deletes the session.
 *
 * If it is a desktop environment, it will close all listeners.
 *
 * If it is a B2G environment, it will make the main content listener
 * sleep, and close all other listeners.  The main content listener
 * persists after disconnect (it's the homescreen), and can safely
 * be reused.
 */
GeckoDriver.prototype.sessionTearDown = function(cmd, resp) {
  if (this.curBrowser != null) {
    if (this.appName == "B2G") {
      globalMessageManager.broadcastAsyncMessage(
          "Marionette:sleepSession" + this.curBrowser.mainContentId, {});
      this.curBrowser.knownFrames.splice(
          this.curBrowser.knownFrames.indexOf(this.curBrowser.mainContentId), 1);
    } else {
      // don't set this pref for B2G since the framescript can be safely reused
      Services.prefs.setBoolPref("marionette.contentListener", false);
    }

    // delete session in each frame in each browser
    for (let win in this.browsers) {
      let browser = this.browsers[win];
      for (let i in browser.knownFrames) {
        globalMessageManager.broadcastAsyncMessage(
            "Marionette:deleteSession" + browser.knownFrames[i], {});
      }
    }

    let winEn = this.getWinEnumerator();
    while (winEn.hasMoreElements()) {
      winEn.getNext().messageManager.removeDelayedFrameScript(FRAME_SCRIPT);
    }

    this.curBrowser.frameManager.removeSpecialPowers();
    this.curBrowser.frameManager.removeMessageManagerListeners(
        globalMessageManager);
  }

  this.switchToGlobalMessageManager();

  // reset frame to the top-most frame
  this.curFrame = null;
  if (this.mainFrame)
    this.mainFrame.focus();

  this.sessionId = null;
  this.deleteFile("marionetteChromeScripts");
  this.deleteFile("marionetteContentScripts");

  if (this.observing !== null) {
    for (let topic in this.observing) {
      Services.obs.removeObserver(this.observing[topic], topic);
    }
    this.observing = null;
  }
};

/**
 * Processes the "deleteSession" request from the client by tearing down
 * the session and responding "ok".
 */
GeckoDriver.prototype.deleteSession = function(cmd, resp) {
  this.sessionTearDown();
};

/** Returns the current status of the Application Cache. */
GeckoDriver.prototype.getAppCacheStatus = function(cmd, resp) {
  resp.value = yield this.listener.getAppCacheStatus();
};

GeckoDriver.prototype.importScript = function(cmd, resp) {
  let script = cmd.parameters.script;

  let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
      .createInstance(Ci.nsIScriptableUnicodeConverter);
  converter.charset = "UTF-8";
  let result = {};
  let data = converter.convertToByteArray(cmd.parameters.script, result);
  let ch = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
  ch.init(ch.MD5);
  ch.update(data, data.length);
  let hash = ch.finish(true);
  // return if we've already imported this script
  if (this.importedScriptHashes[this.context].indexOf(hash) > -1)
    return;
  this.importedScriptHashes[this.context].push(hash);

  switch (this.context) {
    case Context.CHROME:
      let file;
      if (this.importedScripts.exists()) {
        file = FileUtils.openFileOutputStream(this.importedScripts,
            FileUtils.MODE_APPEND | FileUtils.MODE_WRONLY);
      } else {
        // the permission bits here don't actually get set (bug 804563)
        this.importedScripts.createUnique(
            Ci.nsIFile.NORMAL_FILE_TYPE, parseInt("0666", 8));
        file = FileUtils.openFileOutputStream(this.importedScripts,
            FileUtils.MODE_WRONLY | FileUtils.MODE_CREATE);
        this.importedScripts.permissions = parseInt("0666", 8);
      }
      file.write(script, script.length);
      file.close();
      break;

    case Context.CONTENT:
      yield this.listener.importScript({script: script});
      break;
  }
};

GeckoDriver.prototype.clearImportedScripts = function(cmd, resp) {
  switch (this.context) {
    case Context.CHROME:
      this.deleteFile("marionetteChromeScripts");
      break;

    case Context.CONTENT:
      this.deleteFile("marionetteContentScripts");
      break;
  }
};

/**
 * Takes a screenshot of a web element, current frame, or viewport.
 *
 * The screen capture is returned as a lossless PNG image encoded as
 * a base 64 string.
 *
 * If called in the content context, the <code>id</code> argument is not null
 * and refers to a present and visible web element's ID, the capture area
 * will be limited to the bounding box of that element. Otherwise, the
 * capture area will be the bounding box of the current frame.
 *
 * If called in the chrome context, the screenshot will always represent the
 * entire viewport.
 *
 * @param {string} id
 *     Reference to a web element.
 * @param {string} highlights
 *     List of web elements to highlight.
 *
 * @return {string}
 *     PNG image encoded as base64 encoded string.
 */
GeckoDriver.prototype.takeScreenshot = function(cmd, resp) {
  switch (this.context) {
    case Context.CHROME:
      let win = this.getCurrentWindow();
      let canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      let doc;
      if (this.appName == "B2G")
        doc = win.document.body;
      else
        doc = win.document.getElementsByTagName("window")[0];
      let docRect = doc.getBoundingClientRect();
      let width = docRect.width;
      let height = docRect.height;

      // Convert width and height from CSS pixels (potentially fractional)
      // to device pixels (integer).
      let scale = win.devicePixelRatio;
      canvas.setAttribute("width", Math.round(width * scale));
      canvas.setAttribute("height", Math.round(height * scale));

      let context = canvas.getContext("2d");
      let flags;
      if (this.appName == "B2G") {
        flags =
          context.DRAWWINDOW_DRAW_CARET |
          context.DRAWWINDOW_DRAW_VIEW |
          context.DRAWWINDOW_USE_WIDGET_LAYERS;
      } else {
        // Bug 1075168: CanvasRenderingContext2D image is distorted
        // when using certain flags in chrome context.
        flags =
          context.DRAWWINDOW_DRAW_VIEW |
          context.DRAWWINDOW_USE_WIDGET_LAYERS;
      }
      context.scale(scale, scale);
      context.drawWindow(win, 0, 0, width, height, "rgb(255,255,255)", flags);
      let dataUrl = canvas.toDataURL("image/png", "");
      let data = dataUrl.substring(dataUrl.indexOf(",") + 1);
      resp.value = data;
      break;

    case Context.CONTENT:
      resp.value = yield this.listener.takeScreenshot({
        id: cmd.parameters.id,
        highlights: cmd.parameters.highlights,
        full: cmd.parameters.full});
      break;
  }
};

/**
 * Get the current browser orientation.
 *
 * Will return one of the valid primary orientation values
 * portrait-primary, landscape-primary, portrait-secondary, or
 * landscape-secondary.
 */
GeckoDriver.prototype.getScreenOrientation = function(cmd, resp) {
  resp.value = this.getCurrentWindow().screen.mozOrientation;
};

/**
 * Set the current browser orientation.
 *
 * The supplied orientation should be given as one of the valid
 * orientation values.  If the orientation is unknown, an error will
 * be raised.
 *
 * Valid orientations are "portrait" and "landscape", which fall
 * back to "portrait-primary" and "landscape-primary" respectively,
 * and "portrait-secondary" as well as "landscape-secondary".
 */
GeckoDriver.prototype.setScreenOrientation = function(cmd, resp) {
  const ors = [
    "portrait", "landscape",
    "portrait-primary", "landscape-primary",
    "portrait-secondary", "landscape-secondary"
  ];

  let or = String(cmd.parameters.orientation);
  let mozOr = or.toLowerCase();
  if (ors.indexOf(mozOr) < 0)
    throw new WebDriverError(`Unknown screen orientation: ${or}`);

  let win = this.getCurrentWindow();
  if (!win.screen.mozLockOrientation(mozOr))
    throw new WebDriverError(`Unable to set screen orientation: ${or}`);
};

/**
 * Get the size of the browser window currently in focus.
 *
 * Will return the current browser window size in pixels. Refers to
 * window outerWidth and outerHeight values, which include scroll bars,
 * title bars, etc.
 */
GeckoDriver.prototype.getWindowSize = function(cmd, resp) {
  let win = this.getCurrentWindow();
  resp.value = {width: win.outerWidth, height: win.outerHeight};
};

/**
 * Set the size of the browser window currently in focus.
 *
 * Not supported on B2G. The supplied width and height values refer to
 * the window outerWidth and outerHeight values, which include scroll
 * bars, title bars, etc.
 *
 * An error will be returned if the requested window size would result
 * in the window being in the maximized state.
 */
GeckoDriver.prototype.setWindowSize = function(cmd, resp) {
  if (this.appName !== "Firefox")
    throw new UnsupportedOperationError("Not supported on mobile");

  let width = parseInt(cmd.parameters.width);
  let height = parseInt(cmd.parameters.height);

  let win = this.getCurrentWindow();
  if (width >= win.screen.availWidth && height >= win.screen.availHeight)
    throw new UnsupportedOperationError("Invalid requested size, cannot maximize");

  win.resizeTo(width, height);
};

/**
 * Maximizes the user agent window as if the user pressed the maximise
 * button.
 *
 * Not Supported on B2G or Fennec.
 */
GeckoDriver.prototype.maximizeWindow = function(cmd, resp) {
  if (this.appName != "Firefox")
    throw new UnsupportedOperationError("Not supported for mobile");

  let win = this.getCurrentWindow();
  win.moveTo(0,0);
  win.resizeTo(win.screen.availWidth, win.screen.availHeight);
};

/**
 * Dismisses a currently displayed tab modal, or returns no such alert if
 * no modal is displayed.
 */
GeckoDriver.prototype.dismissDialog = function(cmd, resp) {
  if (!this.dialog)
    throw new NoAlertOpenError(
        "No tab modal was open when attempting to dismiss the dialog");

  let {button0, button1} = this.dialog.ui;
  (button1 ? button1 : button0).click();
  this.dialog = null;
};

/**
 * Accepts a currently displayed tab modal, or returns no such alert if
 * no modal is displayed.
 */
GeckoDriver.prototype.acceptDialog = function(cmd, resp) {
  if (!this.dialog)
    throw new NoAlertOpenError(
        "No tab modal was open when attempting to accept the dialog");

  let {button0} = this.dialog.ui;
  button0.click();
  this.dialog = null;
};

/**
 * Returns the message shown in a currently displayed modal, or returns a no such
 * alert error if no modal is currently displayed.
 */
GeckoDriver.prototype.getTextFromDialog = function(cmd, resp) {
  if (!this.dialog)
    throw new NoAlertOpenError(
        "No tab modal was open when attempting to get the dialog text");

  let {infoBody} = this.dialog.ui;
  resp.value = infoBody.textContent;
};

/**
 * Sends keys to the input field of a currently displayed modal, or
 * returns a no such alert error if no modal is currently displayed. If
 * a tab modal is currently displayed but has no means for text input,
 * an element not visible error is returned.
 */
GeckoDriver.prototype.sendKeysToDialog = function(cmd, resp) {
  if (!this.dialog)
    throw new NoAlertOpenError(
        "No tab modal was open when attempting to send keys to a dialog");

  // see toolkit/components/prompts/content/commonDialog.js
  let {loginContainer, loginTextbox} = this.dialog.ui;
  if (loginContainer.hidden)
    throw new ElementNotVisibleError("This prompt does not accept text input");

  let win = this.dialog.window ? this.dialog.window : this.getCurrentWindow();
  utils.sendKeysToElement(
      win,
      loginTextbox,
      cmd.parameters.value,
      () => {},
      e => { throw e; },
      this.command_id,
      true /* ignore visibility check */);
};

/**
 * Helper function to convert an outerWindowID into a UID that Marionette
 * tracks.
 */
GeckoDriver.prototype.generateFrameId = function(id) {
  let uid = id + (this.appName == "B2G" ? "-b2g" : "");
  return uid;
};

/** Receives all messages from content messageManager. */
GeckoDriver.prototype.receiveMessage = function(message) {
  // we need to just check if we need to remove the mozbrowserclose listener
  if (this.mozBrowserClose !== null) {
    let win = this.getCurrentWindow();
    win.removeEventListener("mozbrowserclose", this.mozBrowserClose, true);
    this.mozBrowserClose = null;
  }

  switch (message.name) {
    case "Marionette:log":
      // log server-side messages
      logger.info(message.json.message);
      break;

    case "Marionette:shareData":
      // log messages from tests
      if (message.json.log)
        this.marionetteLog.addLogs(message.json.log);
      break;

    case "Marionette:runEmulatorCmd":
    case "Marionette:runEmulatorShell":
      this.emulator.send(message.json);
      break;

    case "Marionette:switchToModalOrigin":
      this.curBrowser.frameManager.switchToModalOrigin(message);
      this.mm = this.curBrowser.frameManager
          .currentRemoteFrame.messageManager.get();
      break;

    case "Marionette:switchedToFrame":
      if (message.json.restorePrevious) {
        this.currentFrameElement = this.previousFrameElement;
      } else {
        // we don't arbitrarily save previousFrameElement, since
        // we allow frame switching after modals appear, which would
        // override this value and we'd lose our reference
        if (message.json.storePrevious)
          this.previousFrameElement = this.currentFrameElement;
        this.currentFrameElement = message.json.frameValue;
      }
      break;

    case "Marionette:getVisibleCookies":
      let [currentPath, host] = message.json.value;
      let isForCurrentPath = path => currentPath.indexOf(path) != -1;
      let results = [];

      let en = cookieManager.enumerator;
      while (en.hasMoreElements()) {
        let cookie = en.getNext().QueryInterface(Ci.nsICookie);
        // take the hostname and progressively shorten
        let hostname = host;
        do {
          if ((cookie.host == "." + hostname || cookie.host == hostname) &&
              isForCurrentPath(cookie.path)) {
            results.push({
              "name": cookie.name,
              "value": cookie.value,
              "path": cookie.path,
              "host": cookie.host,
              "secure": cookie.isSecure,
              "expiry": cookie.expires
            });
            break;
          }
          hostname = hostname.replace(/^.*?\./, "");
        } while (hostname.indexOf(".") != -1);
      }
      return results;

    case "Marionette:addCookie":
      let cookieToAdd = message.json.value;
      Services.cookies.add(
          cookieToAdd.domain,
          cookieToAdd.path,
          cookieToAdd.name,
          cookieToAdd.value,
          cookieToAdd.secure,
          false,
          false,
          cookieToAdd.expiry);
      return true;
 
    case "Marionette:deleteCookie":
      let cookieToDelete = message.json.value;
      cookieManager.remove(
          cookieToDelete.host,
          cookieToDelete.name,
          cookieToDelete.path,
          false);
      return true;

    case "Marionette:emitTouchEvent":
      globalMessageManager.broadcastAsyncMessage(
          "MarionetteMainListener:emitTouchEvent", message.json);
      break;

    case "Marionette:register":
      let wid = message.json.value;
      let be = message.target;
      let rv = this.registerBrowser(wid, be);
      return rv;

    case "Marionette:listenersAttached":
      if (message.json.listenerId === this.curBrowser.curFrameId) {
        // If remoteness gets updated we need to call newSession. In the case
        // of desktop this just sets up a small amount of state that doesn't
        // change over the course of a session.
        let newSessionValues = {
          B2G: (this.appName == "B2G"),
          raisesAccessibilityExceptions:
              this.sessionCapabilities.raisesAccessibilityExceptions
        };
        this.sendAsync("newSession", newSessionValues);
        this.curBrowser.flushPendingCommands();
      }
      break;
  }
};

GeckoDriver.prototype.responseCompleted = function () {
  if (this.curBrowser !== null) {
    this.curBrowser.pendingCommands = [];
  }
};

GeckoDriver.prototype.commands = {
  "getMarionetteID": GeckoDriver.prototype.getMarionetteID,
  "sayHello": GeckoDriver.prototype.sayHello,
  "newSession": GeckoDriver.prototype.newSession,
  "getSessionCapabilities": GeckoDriver.prototype.getSessionCapabilities,
  "log": GeckoDriver.prototype.log,
  "getLogs": GeckoDriver.prototype.getLogs,
  "setContext": GeckoDriver.prototype.setContext,
  "getContext": GeckoDriver.prototype.getContext,
  "executeScript": GeckoDriver.prototype.execute,
  "setScriptTimeout": GeckoDriver.prototype.setScriptTimeout,
  "timeouts": GeckoDriver.prototype.timeouts,
  "singleTap": GeckoDriver.prototype.singleTap,
  "actionChain": GeckoDriver.prototype.actionChain,
  "multiAction": GeckoDriver.prototype.multiAction,
  "executeAsyncScript": GeckoDriver.prototype.executeWithCallback,
  "executeJSScript": GeckoDriver.prototype.executeJSScript,
  "setSearchTimeout": GeckoDriver.prototype.setSearchTimeout,
  "findElement": GeckoDriver.prototype.findElement,
  "findChildElement": GeckoDriver.prototype.findChildElements, // Needed for WebDriver compat
  "findElements": GeckoDriver.prototype.findElements,
  "findChildElements":GeckoDriver.prototype.findChildElements, // Needed for WebDriver compat
  "clickElement": GeckoDriver.prototype.clickElement,
  "getElementAttribute": GeckoDriver.prototype.getElementAttribute,
  "getElementText": GeckoDriver.prototype.getElementText,
  "getElementTagName": GeckoDriver.prototype.getElementTagName,
  "isElementDisplayed": GeckoDriver.prototype.isElementDisplayed,
  "getElementValueOfCssProperty": GeckoDriver.prototype.getElementValueOfCssProperty,
  "submitElement": GeckoDriver.prototype.submitElement,
  "getElementSize": GeckoDriver.prototype.getElementSize,  //deprecated
  "getElementRect": GeckoDriver.prototype.getElementRect,
  "isElementEnabled": GeckoDriver.prototype.isElementEnabled,
  "isElementSelected": GeckoDriver.prototype.isElementSelected,
  "sendKeysToElement": GeckoDriver.prototype.sendKeysToElement,
  "getElementLocation": GeckoDriver.prototype.getElementLocation,  // deprecated
  "getElementPosition": GeckoDriver.prototype.getElementLocation,  // deprecated
  "clearElement": GeckoDriver.prototype.clearElement,
  "getTitle": GeckoDriver.prototype.getTitle,
  "getWindowType": GeckoDriver.prototype.getWindowType,
  "getPageSource": GeckoDriver.prototype.getPageSource,
  "get": GeckoDriver.prototype.get,
  "goUrl": GeckoDriver.prototype.get,  // deprecated
  "getCurrentUrl": GeckoDriver.prototype.getCurrentUrl,
  "getUrl": GeckoDriver.prototype.getCurrentUrl,  // deprecated
  "goBack": GeckoDriver.prototype.goBack,
  "goForward": GeckoDriver.prototype.goForward,
  "refresh":  GeckoDriver.prototype.refresh,
  "getWindowHandle": GeckoDriver.prototype.getWindowHandle,
  "getCurrentWindowHandle":  GeckoDriver.prototype.getWindowHandle,  // Selenium 2 compat
  "getChromeWindowHandle": GeckoDriver.prototype.getChromeWindowHandle,
  "getCurrentChromeWindowHandle": GeckoDriver.prototype.getChromeWindowHandle,
  "getWindow":  GeckoDriver.prototype.getWindowHandle,  // deprecated
  "getWindowHandles": GeckoDriver.prototype.getWindowHandles,
  "getChromeWindowHandles": GeckoDriver.prototype.getChromeWindowHandles,
  "getCurrentWindowHandles": GeckoDriver.prototype.getWindowHandles,  // Selenium 2 compat
  "getWindows":  GeckoDriver.prototype.getWindowHandles,  // deprecated
  "getWindowPosition": GeckoDriver.prototype.getWindowPosition,
  "setWindowPosition": GeckoDriver.prototype.setWindowPosition,
  "getActiveFrame": GeckoDriver.prototype.getActiveFrame,
  "switchToFrame": GeckoDriver.prototype.switchToFrame,
  "switchToWindow": GeckoDriver.prototype.switchToWindow,
  "deleteSession": GeckoDriver.prototype.deleteSession,
  "importScript": GeckoDriver.prototype.importScript,
  "clearImportedScripts": GeckoDriver.prototype.clearImportedScripts,
  "getAppCacheStatus": GeckoDriver.prototype.getAppCacheStatus,
  "close": GeckoDriver.prototype.close,
  "closeWindow": GeckoDriver.prototype.close,  // deprecated
  "closeChromeWindow": GeckoDriver.prototype.closeChromeWindow,
  "setTestName": GeckoDriver.prototype.setTestName,
  "takeScreenshot": GeckoDriver.prototype.takeScreenshot,
  "screenShot": GeckoDriver.prototype.takeScreenshot,  // deprecated
  "screenshot": GeckoDriver.prototype.takeScreenshot,  // Selenium 2 compat
  "addCookie": GeckoDriver.prototype.addCookie,
  "getCookies": GeckoDriver.prototype.getCookies,
  "getAllCookies": GeckoDriver.prototype.getCookies,  // deprecated
  "deleteAllCookies": GeckoDriver.prototype.deleteAllCookies,
  "deleteCookie": GeckoDriver.prototype.deleteCookie,
  "getActiveElement": GeckoDriver.prototype.getActiveElement,
  "getScreenOrientation": GeckoDriver.prototype.getScreenOrientation,
  "setScreenOrientation": GeckoDriver.prototype.setScreenOrientation,
  "getWindowSize": GeckoDriver.prototype.getWindowSize,
  "setWindowSize": GeckoDriver.prototype.setWindowSize,
  "maximizeWindow": GeckoDriver.prototype.maximizeWindow,
  "dismissDialog": GeckoDriver.prototype.dismissDialog,
  "acceptDialog": GeckoDriver.prototype.acceptDialog,
  "getTextFromDialog": GeckoDriver.prototype.getTextFromDialog,
  "sendKeysToDialog": GeckoDriver.prototype.sendKeysToDialog
};

/**
 * Represents the current modal dialogue.
 *
 * @param {function(): BrowserObj} curBrowserFn
 *     Function that returns the current BrowserObj.
 * @param {?nsIWeakReference} winRef
 *     A weak reference to the current ChromeWindow.
 */
this.ModalDialog = function(curBrowserFn, winRef=null) {
  Object.defineProperty(this, "curBrowser", {
    get() { return curBrowserFn(); }
  });
  this.win_ = winRef;
};

/**
 * Returns the ChromeWindow associated with an open dialog window if it is
 * currently attached to the dom.
 *
 */
Object.defineProperty(ModalDialog.prototype, "window", {
  get() {
    if (this.win_ !== null) {
      let win = this.win_.get();
      if (win && win.parent)
        return win;
    }
    return null;
  }
});

Object.defineProperty(ModalDialog.prototype, "ui", {
  get() {
    let win = this.window;
    if (win)
      return win.Dialog.ui;
    return this.curBrowser.getTabModalUI();
  }
});

/**
 * Creates a BrowserObj.  BrowserObjs handle interactions with the
 * browser, according to the current environment (desktop, b2g, etc.).
 *
 * @param {nsIDOMWindow} win
 *     The window whose browser needs to be accessed.
 * @param {GeckoDriver} driver
 *     Reference to the driver the browser is attached to.
 */
let BrowserObj = function(win, driver) {
  this.browser = undefined;
  this.window = win;
  this.driver = driver;
  this.knownFrames = [];
  this.startPage = "about:blank";
  // used in B2G to identify the homescreen content page
  this.mainContentId = null;
  // used to set curFrameId upon new session
  this.newSession = true;
  this.elementManager = new ElementManager([NAME, LINK_TEXT, PARTIAL_LINK_TEXT]);
  this.setBrowser(win);

  // A reference to the tab corresponding to the current window handle, if any.
  this.tab = null;
  this.pendingCommands = [];

  // we should have one FM per BO so that we can handle modals in each Browser
  this.frameManager = new FrameManager(driver);
  this.frameRegsPending = 0;

  // register all message listeners
  this.frameManager.addMessageManagerListeners(driver.mm);
  this.getIdForBrowser = driver.getIdForBrowser.bind(driver);
  this.updateIdForBrowser = driver.updateIdForBrowser.bind(driver);
  this._curFrameId = null;
  this._browserWasRemote = null;
  this._hasRemotenessChange = false;
};

Object.defineProperty(BrowserObj.prototype, "browserForTab", {
  get() {
    return this.browser.getBrowserForTab(this.tab);
  }
});

/**
 * The current frame ID is managed per browser element on desktop in
 * case the ID needs to be refreshed. The currently selected window is
 * identified within BrowserObject by a tab.
 */
Object.defineProperty(BrowserObj.prototype, "curFrameId", {
  get() {
    let rv = null;
    if (this.driver.appName != "Firefox") {
      rv = this._curFrameId;
    } else if (this.tab) {
      rv = this.getIdForBrowser(this.browserForTab);
    }
    return rv;
  },

  set(id) {
    if (this.driver.appName != "Firefox") {
      this._curFrameId = id;
    }
  }
});

/**
 * Retrieves the current tabmodal UI object.  According to the browser
 * associated with the currently selected tab.
 */
BrowserObj.prototype.getTabModalUI = function() {
  let br = this.browserForTab;
  if (!br.hasAttribute("tabmodalPromptShowing"))
    return null;

  // The modal is a direct sibling of the browser element.
  // See tabbrowser.xml's getTabModalPromptBox.
  let modals = br.parentNode.getElementsByTagNameNS(
      XUL_NS, "tabmodalprompt");
  return modals[0].ui;
};

/**
 * Set the browser if the application is not B2G.
 *
 * @param {nsIDOMWindow} win
 *     Current window reference.
 */
BrowserObj.prototype.setBrowser = function(win) {
  switch (this.driver.appName) {
    case "Firefox":
      this.browser = win.gBrowser;
      break;

    case "Fennec":
      this.browser = win.BrowserApp;
      break;

    case "B2G":
      // eideticker (bug 965297) and mochitest (bug 965304)
      // compatibility.  They only check for the presence of this
      // property and should not be in caps if not on a B2G device.
      this.driver.sessionCapabilities.b2g = true;
      break;
  }
};

/** Called when we start a session with this browser. */
BrowserObj.prototype.startSession = function(newSession, win, callback) {
  callback(win, newSession);
};

/** Closes current tab. */
BrowserObj.prototype.closeTab = function() {
  if (this.browser &&
      this.browser.removeTab &&
      this.tab != null && (this.driver.appName != "B2G")) {
    this.browser.removeTab(this.tab);
  }
};

/**
 * Opens a tab with given URI.
 *
 * @param {string} uri
 *      URI to open.
 */
BrowserObj.prototype.addTab = function(uri) {
  return this.browser.addTab(uri, true);
};

/**
 * Re-sets this BrowserObject's current tab and updates remoteness tracking.
 */
BrowserObj.prototype.switchToTab = function(ind) {
  if (this.browser) {
    this.browser.selectTabAtIndex(ind);
    this.tab = this.browser.selectedTab;
  }
  this._browserWasRemote = this.browserForTab.isRemoteBrowser;
  this._hasRemotenessChange = false;
};

/**
 * Registers a new frame, and sets its current frame id to this frame
 * if it is not already assigned, and if a) we already have a session
 * or b) we're starting a new session and it is the right start frame.
 *
 * @param {string} uid
 *     Frame uid for use by Marionette.
 * @param the XUL <browser> that was the target of the originating message.
 */
BrowserObj.prototype.register = function(uid, target) {
  let remotenessChange = this.hasRemotenessChange();
  if (this.curFrameId === null || remotenessChange) {
    if (this.browser) {
      // If we're setting up a new session on Firefox, we only process the
      // registration for this frame if it belongs to the current tab.
      if (!this.tab)
        this.switchToTab(this.browser.selectedIndex);

      if (target == this.browserForTab) {
        this.updateIdForBrowser(this.browserForTab, uid);
        this.mainContentId = uid;
      }
    } else {
      this._curFrameId = uid;
      this.mainContentId = uid;
    }
  }

  // used to delete sessions
  this.knownFrames.push(uid);
  return remotenessChange;
};

/**
 * When navigating between pages results in changing a browser's
 * process, we need to take measures not to lose contact with a listener
 * script. This function does the necessary bookkeeping.
 */
BrowserObj.prototype.hasRemotenessChange = function() {
  // None of these checks are relevant on b2g or if we don't have a tab yet,
  // and may not apply on Fennec.
  if (this.driver.appName != "Firefox" || this.tab === null)
    return false;

  if (this._hasRemotenessChange)
    return true;

  let currentIsRemote = this.browserForTab.isRemoteBrowser;
  this._hasRemotenessChange = this._browserWasRemote !== currentIsRemote;
  this._browserWasRemote = currentIsRemote;
  return this._hasRemotenessChange;
};

/**
 * Flushes any pending commands queued when a remoteness change is being
 * processed and mark this remotenessUpdate as complete.
 */
BrowserObj.prototype.flushPendingCommands = function() {
  if (!this._hasRemotenessChange)
    return;

  this._hasRemotenessChange = false;
  this.pendingCommands.forEach(cb => cb());
  this.pendingCommands = [];
};

/**
  * This function intercepts commands interacting with content and queues
  * or executes them as needed.
  *
  * No commands interacting with content are safe to process until
  * the new listener script is loaded and registers itself.
  * This occurs when a command whose effect is asynchronous (such
  * as goBack) results in a remoteness change and new commands
  * are subsequently posted to the server.
  */
BrowserObj.prototype.executeWhenReady = function(cb) {
  if (this.hasRemotenessChange())
    this.pendingCommands.push(cb);
  else
    cb();
};
