/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Rough test that the recording still continues after a refresh.
 */
function* spawnTest() {
  let { panel, target } = yield initPerformance(SIMPLE_URL);
  let { EVENTS, PerformanceController } = panel.panelWin;

  // Enable memory to test all the overview graphs.
  Services.prefs.setBoolPref(MEMORY_PREF, true);

  yield startRecording(panel);

  yield reload(target)

  let rec = PerformanceController.getCurrentRecording();
  let { markers, memory, ticks } = rec.getAllData();
  // Store current length of items
  let markersLength = markers.length;
  let memoryLength = memory.length;
  let ticksLength = ticks.length;

  ok(rec.isRecording(), "RecordingModel should still be recording after reload");

  yield busyWait(100);
  yield waitUntil(() => rec.getMarkers().length > markersLength);
  yield waitUntil(() => rec.getMemory().length > memoryLength);
  yield waitUntil(() => rec.getTicks().length > ticksLength);
  ok("Markers, memory and ticks continue after reload");

  yield stopRecording(panel);

  let { allocations, profile, frames } = rec.getAllData();
  ok(allocations, "allocations exist after refresh");
  ok(profile, "profile exists after refresh");
  ok(frames, "frames exist after refresh");

  yield teardown(panel);
  finish();
}
