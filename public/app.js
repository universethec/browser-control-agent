/**
 * public/app.js — Browser Control Agent WS client
 *
 * Vanilla IIFE (no modules, no bundler, no imports).
 * Implements the full UI-SPEC WebSocket Event → UI State Map.
 *
 * ServerEvent types (inbound):
 *   status { step, text }
 *   screenshot { step, jpegBase64 }
 *   clarify { question, options? }
 *   result { ok, summary, data? }
 *   error { message }
 *   done {}
 *
 * ClientEvent types (outbound):
 *   command { text }
 *   answer { text }
 *   stop {}
 */
(function () {
  "use strict";

  /* -------------------------------------------------------
     DOM references — must match ids/classes in index.html
  ------------------------------------------------------- */
  var thread        = document.getElementById("thread");
  var composerInput = document.getElementById("composer-input");
  var runButton     = document.getElementById("run-btn");
  var stopButton    = document.getElementById("stop-btn");
  var screenshotImg = document.getElementById("screenshot");
  var idleState     = document.getElementById("idle-state");
  var composer      = document.getElementById("composer");
  var panel         = document.getElementById("panel");
  var loader        = document.getElementById("loader");

  /* -------------------------------------------------------
     Run state machine (UI-SPEC Implementation Note #7)
  ------------------------------------------------------- */
  var isRunActive  = false;
  var isAnswerMode = false;  // D-04: true after clarify with no options
  var defaultPlaceholder = composerInput.placeholder;  // restored when leaving answer mode

  /**
   * setRunActive(active)
   * Toggles composer enabled/disabled, Run/Stop visibility.
   */
  function setRunActive(active) {
    isRunActive = active;
    composerInput.disabled = active;
    composerInput.style.opacity = active ? "0.5" : "1";
    composerInput.style.cursor = active ? "not-allowed" : "";
    runButton.style.display = active ? "none" : "";
    stopButton.style.display = active ? "" : "none";
  }

  /**
   * dockPanel()
   * One-time transition: the centered command modal docks to the bottom-left as a
   * compact panel once the first command is sent, revealing the full-screen browser.
   * Brief opacity fade so the center→corner reposition isn't a jarring reflow.
   */
  function dockPanel() {
    if (!panel.classList.contains("panel--center")) return;
    panel.classList.remove("panel--center");
    panel.classList.add("panel--docked");
  }

  /* -------------------------------------------------------
     DOM mutation helpers
  ------------------------------------------------------- */

  /**
   * appendStatusBubble(step, text)
   * Appends a status narration bubble with [N] step prefix.
   * Used for status events AND optimistic "Run stopped." message.
   * @param {number|null} step  — step counter, or 0 for synthetic messages
   * @param {string} text       — narration text
   * @param {boolean} [tertiary] — if true, render text in ink-tertiary color
   */
  function appendStatusBubble(step, text, tertiary) {
    var bubble = document.createElement("div");
    bubble.className = "status-bubble";
    if (tertiary) {
      bubble.style.color = "var(--color-ink-tertiary)";
    }

    var stepSpan = document.createElement("span");
    stepSpan.className = "step-counter";
    stepSpan.textContent = "[" + step + "] ";

    var textNode = document.createTextNode(text);

    bubble.appendChild(stepSpan);
    bubble.appendChild(textNode);
    thread.appendChild(bubble);
    scrollThread();
    return bubble;
  }

  /**
   * appendUserBubble(text)
   * Appends the user's command text as a distinct user bubble (D-03).
   */
  function appendUserBubble(text) {
    var bubble = document.createElement("div");
    bubble.className = "user-bubble";
    bubble.textContent = text;
    thread.appendChild(bubble);
    scrollThread();
  }

  /**
   * appendResultBubble(ok, summary)
   * Appends a result bubble. ok=true → ink primary; ok=false → ink secondary.
   */
  function appendResultBubble(ok, summary) {
    var bubble = document.createElement("div");
    bubble.className = "result-bubble " + (ok ? "ok-true" : "ok-false");
    bubble.textContent = summary;
    thread.appendChild(bubble);
    scrollThread();
  }

  /**
   * appendErrorBubble(message)
   * Appends a terracotta error bubble (only context for accent as text/bg).
   * Heading "Something went wrong" + message verbatim + retry line.
   */
  function appendErrorBubble(message) {
    var bubble = document.createElement("div");
    bubble.className = "error-bubble";

    var heading = document.createElement("div");
    heading.className = "error-heading";
    heading.textContent = "Something went wrong";

    var msg = document.createElement("div");
    msg.textContent = message;

    var retry = document.createElement("div");
    retry.className = "error-retry";
    retry.textContent = "Check the terminal for details, then try again.";

    bubble.appendChild(heading);
    bubble.appendChild(msg);
    bubble.appendChild(retry);
    thread.appendChild(bubble);
    scrollThread();
  }

  /**
   * appendClarifyBubble(question, options)
   * Appends a clarify bubble with the question and optional chips.
   * If options is empty, switches isAnswerMode = true (D-04).
   * @param {string} question
   * @param {string[]} options
   */
  function appendClarifyBubble(question, options) {
    var bubble = document.createElement("div");
    bubble.className = "clarify-bubble";

    var questionEl = document.createElement("div");
    questionEl.className = "clarify-question";
    questionEl.textContent = question;
    bubble.appendChild(questionEl);

    if (options && options.length > 0) {
      var chipsContainer = document.createElement("div");
      chipsContainer.className = "clarify-chips";

      options.forEach(function (optionText) {
        var chip = document.createElement("button");
        chip.className = "clarify-chip";
        chip.type = "button";
        chip.textContent = optionText;

        chip.addEventListener("click", function () {
          // CRITICAL (Pitfall 6 / T-04-double-answer): set disabled synchronously FIRST
          chip.disabled = true;

          // Disable all chips in this set — pointer-events:none + visual dim
          var allChips = chipsContainer.querySelectorAll(".clarify-chip");
          allChips.forEach(function (c) {
            c.disabled = true;
            c.classList.add("clicked");
          });

          // Dim the clicked chip specifically to ink-tertiary (CSS handles .clicked)
          chip.style.color = "var(--color-ink-tertiary)";

          // Send answer frame
          sendEvent({ type: "answer", text: optionText });
        });

        chipsContainer.appendChild(chip);
      });

      bubble.appendChild(chipsContainer);
    } else {
      // No options — switch composer to answer mode (D-04 / UI-SPEC Note #8).
      // The run is PAUSED awaiting the typed answer — clarify sends no `done`, so the
      // composer is still disabled from the command's setRunActive(true). Re-enable it
      // (UI is now idle-awaiting-input: input editable, Run shown as the submit button)
      // so the user can actually type the answer.
      isAnswerMode = true;
      setRunActive(false);
      composerInput.placeholder = "Type your answer…";
      composerInput.focus();
    }

    thread.appendChild(bubble);
    scrollThread();
  }

  /**
   * updateScreenshot(jpegBase64)
   * Sets the screenshot img src to the data URI and hides the idle state.
   */
  function updateScreenshot(jpegBase64) {
    loader.style.display = "none"; // first frame arrived — hide the loading animation
    screenshotImg.src = "data:image/jpeg;base64," + jpegBase64;
    screenshotImg.style.display = "block";
    // Idle hint visibility is governed by the panel's docked state (CSS), not here.
  }

  /**
   * showDisconnectNotice()
   * Replaces the composer with a static disconnect notice.
   * Called from ws.close handler; does NOT auto-reconnect (UI-SPEC Note #2).
   */
  function showDisconnectNotice() {
    var notice = document.createElement("div");
    notice.id = "disconnect-notice";
    notice.textContent = "Lost connection to backend. Refresh to reconnect.";
    composer.parentNode.replaceChild(notice, composer);
  }

  /**
   * scrollThread()
   * Auto-scrolls the chat thread to the bottom after DOM insertion (Note #3).
   */
  function scrollThread() {
    thread.scrollTop = thread.scrollHeight;
  }

  /* -------------------------------------------------------
     WebSocket event dispatcher
  ------------------------------------------------------- */

  /**
   * handleServerEvent(event)
   * Dispatches a parsed ServerEvent to the correct DOM mutation.
   * This is the authoritative switch implementing the UI-SPEC event→UI map.
   */
  function handleServerEvent(event) {
    if (!event || typeof event.type !== "string") return;

    switch (event.type) {
      case "status":
        appendStatusBubble(event.step, event.text);
        break;

      case "screenshot":
        updateScreenshot(event.jpegBase64);
        break;

      case "clarify":
        appendClarifyBubble(event.question, event.options || []);
        break;

      case "result":
        appendResultBubble(event.ok, event.summary);
        setRunActive(false);
        break;

      case "error":
        appendErrorBubble(event.message);
        setRunActive(false);
        break;

      case "done":
        setRunActive(false);
        break;
    }
  }

  /* -------------------------------------------------------
     ClientEvent send helper
  ------------------------------------------------------- */
  function sendEvent(payload) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  /* -------------------------------------------------------
     Composer submit handler
  ------------------------------------------------------- */
  function handleSubmit() {
    var text = composerInput.value.trim();
    if (!text) return;

    composerInput.value = "";

    if (isAnswerMode) {
      // D-04: answer mode — send the answer, restore the composer, and resume the run.
      // The run was paused awaiting this answer (we set it idle-awaiting-input on the
      // clarify), so re-enter run-active: input disabled, Stop shown, run continues.
      isAnswerMode = false;
      appendUserBubble(text);
      sendEvent({ type: "answer", text: text });
      composerInput.placeholder = defaultPlaceholder;
      setRunActive(true);
    } else {
      // Normal command mode
      appendUserBubble(text);
      sendEvent({ type: "command", text: text });
      setRunActive(true);
      dockPanel(); // first command: centered modal → compact bottom-left panel
      // Show the loading animation until the first browser frame arrives (only when
      // no frame is on screen yet — follow-up commands keep the existing browser view).
      if (screenshotImg.style.display !== "block") {
        loader.style.display = "flex";
      }
    }
  }

  /* -------------------------------------------------------
     WebSocket lifecycle
  ------------------------------------------------------- */
  var ws = new WebSocket("ws://" + location.host);

  ws.addEventListener("open", function () {
    // Connection confirmed — UI is already in idle state, no action needed
  });

  ws.addEventListener("message", function (ev) {
    var event;
    try {
      event = JSON.parse(ev.data);
    } catch (_) {
      // Malformed JSON — drop silently
      return;
    }
    handleServerEvent(event);
  });

  ws.addEventListener("close", function () {
    // UI-SPEC Note #2: show disconnect notice; do NOT auto-reconnect
    showDisconnectNotice();
  });

  ws.addEventListener("error", function () {
    // error always precedes close; the close handler shows the notice
  });

  /* -------------------------------------------------------
     Composer event wiring
  ------------------------------------------------------- */

  // Run button click
  runButton.addEventListener("click", function () {
    if (isRunActive) return;
    handleSubmit();
  });

  // Enter key (without Shift) submits
  composerInput.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      if (!isRunActive || isAnswerMode) {
        handleSubmit();
      }
    }
  });

  // Stop button click — D-02: instant hard stop + optimistic UI reset
  stopButton.addEventListener("click", function () {
    if (!isRunActive) return;
    sendEvent({ type: "stop" });
    setRunActive(false);
    // Optimistic "Run stopped." status bubble (ink-tertiary, step 0)
    appendStatusBubble(0, "Run stopped.", true);
  });

})();
