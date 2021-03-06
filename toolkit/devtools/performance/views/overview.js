/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// No sense updating the overview more often than receiving data from the
// backend. Make sure this isn't lower than DEFAULT_TIMELINE_DATA_PULL_TIMEOUT
// in toolkit/devtools/server/actors/timeline.js
const OVERVIEW_UPDATE_INTERVAL = 200; // ms
const FRAMERATE_GRAPH_LOW_RES_INTERVAL = 100; // ms
const FRAMERATE_GRAPH_HIGH_RES_INTERVAL = 16; // ms
const GRAPH_REQUIREMENTS = {
  timeline: {
    actors: ["timeline"],
    features: ["withMarkers"]
  },
  framerate: {
    actors: ["timeline"],
    features: ["withTicks"]
  },
  memory: {
    actors: ["memory"],
    features: ["withMemory"]
  },
}

/**
 * View handler for the overview panel's time view, displaying
 * framerate, timeline and memory over time.
 */
let OverviewView = {

  /**
   * How frequently we attempt to render the graphs. Overridden
   * in tests.
   */
  OVERVIEW_UPDATE_INTERVAL: OVERVIEW_UPDATE_INTERVAL,

  /**
   * Sets up the view with event binding.
   */
  initialize: function () {
    this.graphs = new GraphsController({
      root: $("#overview-pane"),
      getBlueprint: () => PerformanceController.getTimelineBlueprint(),
      getTheme: () => PerformanceController.getTheme(),
    });

    // If no timeline support, shut it all down.
    if (!gFront.getActorSupport().timeline) {
      this.disable();
      return;
    }

    // Store info on multiprocess support.
    this._multiprocessData = PerformanceController.getMultiprocessStatus();

    this._onRecordingWillStart = this._onRecordingWillStart.bind(this);
    this._onRecordingStarted = this._onRecordingStarted.bind(this);
    this._onRecordingWillStop = this._onRecordingWillStop.bind(this);
    this._onRecordingStopped = this._onRecordingStopped.bind(this);
    this._onRecordingSelected = this._onRecordingSelected.bind(this);
    this._onRecordingTick = this._onRecordingTick.bind(this);
    this._onGraphSelecting = this._onGraphSelecting.bind(this);
    this._onGraphRendered = this._onGraphRendered.bind(this);
    this._onPrefChanged = this._onPrefChanged.bind(this);
    this._onThemeChanged = this._onThemeChanged.bind(this);

    // Toggle the initial visibility of memory and framerate graph containers
    // based off of prefs.
    PerformanceController.on(EVENTS.PREF_CHANGED, this._onPrefChanged);
    PerformanceController.on(EVENTS.THEME_CHANGED, this._onThemeChanged);
    PerformanceController.on(EVENTS.RECORDING_WILL_START, this._onRecordingWillStart);
    PerformanceController.on(EVENTS.RECORDING_STARTED, this._onRecordingStarted);
    PerformanceController.on(EVENTS.RECORDING_WILL_STOP, this._onRecordingWillStop);
    PerformanceController.on(EVENTS.RECORDING_STOPPED, this._onRecordingStopped);
    PerformanceController.on(EVENTS.RECORDING_SELECTED, this._onRecordingSelected);
    this.graphs.on("selecting", this._onGraphSelecting);
    this.graphs.on("rendered", this._onGraphRendered);
  },

  /**
   * Unbinds events.
   */
  destroy: Task.async(function*() {
    PerformanceController.off(EVENTS.PREF_CHANGED, this._onPrefChanged);
    PerformanceController.off(EVENTS.THEME_CHANGED, this._onThemeChanged);
    PerformanceController.off(EVENTS.RECORDING_WILL_START, this._onRecordingWillStart);
    PerformanceController.off(EVENTS.RECORDING_STARTED, this._onRecordingStarted);
    PerformanceController.off(EVENTS.RECORDING_WILL_STOP, this._onRecordingWillStop);
    PerformanceController.off(EVENTS.RECORDING_STOPPED, this._onRecordingStopped);
    PerformanceController.off(EVENTS.RECORDING_SELECTED, this._onRecordingSelected);
    this.graphs.off("selecting", this._onGraphSelecting);
    this.graphs.off("rendered", this._onGraphRendered);
    yield this.graphs.destroy();
  }),

  /**
   * Returns true if any of the overview graphs have mouse dragging active,
   * false otherwise.
   */
  get isMouseActive() {
    // Fetch all graphs currently stored in the GraphsController.
    // These graphs are not necessarily active, but will not have
    // an active mouse, in that case.
    return !!this.graphs.getWidgets().some(e => e.isMouseActive);
  },

  /**
   * Disabled in the event we're using a Timeline mock, so we'll have no
   * timeline, ticks or memory data to show, so just block rendering and hide
   * the panel.
   */
  disable: function () {
    this._disabled = true;
    this.graphs.disableAll();
  },

  /**
   * Returns the disabled status.
   *
   * @return boolean
   */
  isDisabled: function () {
    return this._disabled;
  },

  /**
   * Sets the time interval selection for all graphs in this overview.
   *
   * @param object interval
   *        The { startTime, endTime }, in milliseconds.
   */
  setTimeInterval: function(interval, options = {}) {
    if (this.isDisabled()) {
      return;
    }

    let recording = PerformanceController.getCurrentRecording();
    if (recording == null) {
      throw new Error("A recording should be available in order to set the selection.");
    }
    let mapStart = () => 0;
    let mapEnd = () => recording.getDuration();
    let selection = { start: interval.startTime, end: interval.endTime };
    this._stopSelectionChangeEventPropagation = options.stopPropagation;
    this.graphs.setMappedSelection(selection, { mapStart, mapEnd });
    this._stopSelectionChangeEventPropagation = false;
  },

  /**
   * Gets the time interval selection for all graphs in this overview.
   *
   * @return object
   *         The { startTime, endTime }, in milliseconds.
   */
  getTimeInterval: function() {
    let recording = PerformanceController.getCurrentRecording();

    if (this.isDisabled()) {
      return { startTime: 0, endTime: recording.getDuration() };
    }

    if (recording == null) {
      throw new Error("A recording should be available in order to get the selection.");
    }
    let mapStart = () => 0;
    let mapEnd = () => recording.getDuration();
    let selection = this.graphs.getMappedSelection({ mapStart, mapEnd });
    // If no selection returned, this means the overview graphs have not been rendered
    // yet, so act as if we have no selection (the full recording).
    if (!selection) {
      return { startTime: 0, endTime: recording.getDuration() };
    }
    return { startTime: selection.min, endTime: selection.max };
  },

  /**
   * Method for handling all the set up for rendering the overview graphs.
   *
   * @param number resolution
   *        The fps graph resolution. @see Graphs.jsm
   */
  render: Task.async(function *(resolution) {
    if (this.isDisabled()) {
      return;
    }

    let recording = PerformanceController.getCurrentRecording();
    yield this.graphs.render(recording.getAllData(), resolution);

    // Finished rendering all graphs in this overview.
    this.emit(EVENTS.OVERVIEW_RENDERED, resolution);
  }),

  /**
   * Called at most every OVERVIEW_UPDATE_INTERVAL milliseconds
   * and uses data fetched from the controller to render
   * data into all the corresponding overview graphs.
   */
  _onRecordingTick: Task.async(function *() {
    yield this.render(FRAMERATE_GRAPH_LOW_RES_INTERVAL);
    this._prepareNextTick();
  }),

  /**
   * Called to refresh the timer to keep firing _onRecordingTick.
   */
  _prepareNextTick: function () {
    // Check here to see if there's still a _timeoutId, incase
    // `stop` was called before the _prepareNextTick call was executed.
    if (this.isRendering()) {
      this._timeoutId = setTimeout(this._onRecordingTick, this.OVERVIEW_UPDATE_INTERVAL);
    }
  },

  /**
   * Called when recording will start. No recording because it does not
   * exist yet, but can just disable from here. This will only trigger for
   * manual recordings.
   */
  _onRecordingWillStart: OverviewViewOnStateChange(Task.async(function* () {
    yield this._checkSelection();
    this.graphs.dropSelection();
  })),

  /**
   * Called when recording actually starts.
   */
  _onRecordingStarted: OverviewViewOnStateChange(),

  /**
   * Called when recording will stop.
   */
  _onRecordingWillStop: OverviewViewOnStateChange(),

  /**
   * Called when recording actually stops.
   */
  _onRecordingStopped: OverviewViewOnStateChange(Task.async(function* (_, recording) {
    // Check to see if the recording that just stopped is the current recording.
    // If it is, render the high-res graphs. For manual recordings, it will also
    // be the current recording, but profiles generated by `console.profile` can stop
    // while having another profile selected -- in this case, OverviewView should keep
    // rendering the current recording.
    if (recording !== PerformanceController.getCurrentRecording()) {
      return;
    }
    this.render(FRAMERATE_GRAPH_HIGH_RES_INTERVAL);
    yield this._checkSelection(recording);
  })),

  /**
   * Called when a new recording is selected.
   */
  _onRecordingSelected: OverviewViewOnStateChange(Task.async(function* (_, recording) {
    this._setGraphVisibilityFromRecordingFeatures(recording);

    // If this recording is complete, render the high res graph
    if (recording.isCompleted()) {
      yield this.render(FRAMERATE_GRAPH_HIGH_RES_INTERVAL);
    }
    yield this._checkSelection(recording);
    this.graphs.dropSelection();
  })),

  /**
   * Start the polling for rendering the overview graph.
   */
  _startPolling: function () {
    this._timeoutId = setTimeout(this._onRecordingTick, this.OVERVIEW_UPDATE_INTERVAL);
  },

  /**
   * Stop the polling for rendering the overview graph.
   */
  _stopPolling: function () {
    clearTimeout(this._timeoutId);
    this._timeoutId = null;
  },

  /**
   * Whether or not the overview view is in a state of polling rendering.
   */
  isRendering: function () {
    return !!this._timeoutId;
  },

  /**
   * Makes sure the selection is enabled or disabled in all the graphs,
   * based on whether a recording currently exists and is not in progress.
   */
  _checkSelection: Task.async(function* (recording) {
    let isEnabled = recording ? recording.isCompleted() : false;
    yield this.graphs.selectionEnabled(isEnabled);
  }),

  /**
   * Fired when the graph selection has changed. Called by
   * mouseup and scroll events.
   */
  _onGraphSelecting: function () {
    if (this._stopSelectionChangeEventPropagation) {
      return;
    }
    // If the range is smaller than a pixel (which can happen when performing
    // a click on the graphs), treat this as a cleared selection.
    let interval = this.getTimeInterval();
    if (interval.endTime - interval.startTime < 1) {
      this.emit(EVENTS.OVERVIEW_RANGE_CLEARED);
    } else {
      this.emit(EVENTS.OVERVIEW_RANGE_SELECTED, interval);
    }
  },

  _onGraphRendered: function (_, graphName) {
    switch (graphName) {
      case "timeline":
        this.emit(EVENTS.MARKERS_GRAPH_RENDERED);
        break;
      case "memory":
        this.emit(EVENTS.MEMORY_GRAPH_RENDERED);
        break;
      case "framerate":
        this.emit(EVENTS.FRAMERATE_GRAPH_RENDERED);
        break;
    }
  },

  /**
   * Called whenever a preference in `devtools.performance.ui.` changes.
   * Does not care about the enabling of memory/framerate graphs,
   * because those will set values on a recording model, and
   * the graphs will render based on the existence.
   */
  _onPrefChanged: Task.async(function* (_, prefName, prefValue) {
    switch (prefName) {
      case "hidden-markers": {
        let graph;
        if (graph = yield this.graphs.isAvailable("timeline")) {
          let blueprint = PerformanceController.getTimelineBlueprint();
          graph.setBlueprint(blueprint);
          graph.refresh({ force: true });
        }
        break;
      }
    }
  }),

  _setGraphVisibilityFromRecordingFeatures: function (recording) {
    for (let [graphName, requirements] of Iterator(GRAPH_REQUIREMENTS)) {
      this.graphs.enable(graphName, PerformanceController.isFeatureSupported(requirements));
    }
  },

  /**
   * Fetch the multiprocess status and if e10s is not currently on, disable
   * realtime rendering.
   *
   * @return {boolean}
   */
  isRealtimeRenderingEnabled: function () {
    return this._multiprocessData.enabled;
  },

  /**
   * Show the graphs overview panel when a recording is finished
   * when non-realtime graphs are enabled. Also set the graph visibility
   * so the performance graphs know which graphs to render.
   *
   * @param {RecordingModel} recording
   */
  _showGraphsPanel: function (recording) {
    this._setGraphVisibilityFromRecordingFeatures(recording);
    $("#overview-pane").hidden = false;
  },

  /**
   * Hide the graphs container completely.
   */
  _hideGraphsPanel: function () {
    $("#overview-pane").hidden = true;
  },

  /**
   * Called when `devtools.theme` changes.
   */
  _onThemeChanged: function (_, theme) {
    this.graphs.setTheme({ theme, redraw: true });
  },

  toString: () => "[object OverviewView]"
};

/**
 * Utility that can wrap a method of OverviewView that
 * handles a recording state change like when a recording is starting,
 * stopping, or about to start/stop, and determines whether or not
 * the polling for rendering the overview graphs needs to start or stop.
 * Must be called with the OverviewView context.
 *
 * @param {function?} fn
 * @return {function}
 */
function OverviewViewOnStateChange (fn) {
  return function _onRecordingStateChange (eventName, recording) {
    let currentRecording = PerformanceController.getCurrentRecording();

    // All these methods require a recording to exist selected and
    // from the event name, since there is a delay between starting
    // a recording and changing the selection.
    if (!currentRecording || !recording) {
      return;
    }

    // If realtime rendering is not enabed (e10s not on), then
    // show the disabled message, or the full graphs if the recording is completed
    if (!this.isRealtimeRenderingEnabled()) {
      if (recording.isRecording()) {
        this._hideGraphsPanel();
        // Abort, as we do not want to change polling status.
        return;
      } else {
        this._showGraphsPanel(recording);
      }
    }

    if (this.isRendering() && !currentRecording.isRecording()) {
      this._stopPolling();
    } else if (currentRecording.isRecording() && !this.isRendering()) {
      this._startPolling();
    }
    if (fn) {
      fn.apply(this, arguments);
    }
  }
}

// Decorates the OverviewView as an EventEmitter
EventEmitter.decorate(OverviewView);
