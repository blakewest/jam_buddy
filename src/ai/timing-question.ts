export const TIMING_QUESTION = {
  type: "choice",
  instructions: "Control one repeating drum pattern. Follow these rules in order. 1. If piano.silent_for_ms is at least 1000: choose stop if drums are playing or a start is scheduled, otherwise keep_current. 2. If piano.silent_for_ms is less than 1000, at least one recent_events entry is note_on with velocity greater than zero, drums.status is stopped, and drums.scheduled_start is false: choose start_next_bar. 3. Otherwise choose keep_current. A pending start must be preserved unless rule 1 cancels it.",
  criteria: {
    start_next_bar: "Start the stopped drum pattern at the next bar; only when no start is pending.",
    stop: "Stop playing drums and cancel any pending start.",
    keep_current: "Preserve current playback and any pending start.",
  },
};
