/* ═══════════════════════════════════════════════
   S.I.L.K. AGENT MODE — MULTI-AGENT ORCHESTRATOR
═══════════════════════════════════════════════ */

/**
 * Main entry point for Agent Mode.
 * Called by sendMessage() in index.html when Agent Mode is toggled ON.
 */
async function runAgentMode(userText) {
  if (!userText) return;
  
  // 1. Setup UI for Agent Mode
  // We append the user message manually here since logic was intercepted
  const chat = currentChat();
  const userMsg = { role: 'user', content: userText, ts: Date.now() };
  
  // Handle pending image if any (though agents might not fully use it yet, we attach it to user msg)
  if (state.pendingImage) {
    userMsg.imageBase64 = state.pendingImage.base64;
    userMsg.imageDataUrl = state.pendingImage.dataUrl;
    clearImage();
  }
  
  appendMessage(userMsg); 
  
  // Disable input while agent is running
  document.getElementById('send-btn').disabled = true;
  state.isStreaming = true;

  // Create Terminal Bubble
  const terminalId = createTerminalBubble();
  updateTerminal(terminalId, '> Initializing S.I.L.K. Agent Mode...');

  try {
    // ═══════════════════════════════════════════════
    // PHASE 1: THE ORCHESTRATOR (PLANNER)
    // ═══════════════════════════════════════════════
    updateTerminal(terminalId, '> Orchestrator analyzing request...');
    
    // Get full history for context
    const history = chat.messages.slice(0, -1).map(m => ({
      role: m.role, content: m.content
    }));

    const orchestratorPrompt = 
      `You are the Orchestrator. The user has submitted a complex request. Break this request into two distinct tasks for two worker agents. ` +
      `**Crucial Contract:** If the task involves coding, you MUST explicitly define shared CSS classes, HTML IDs, and JavaScript variable names so the workers are perfectly synced. ` +
      `**Output Format:** You must output STRICTLY a valid JSON object with exactly two keys: "taskA" and "taskB". Do not include markdown formatting or any other text.`;

    // Force Gemma-3-27b-it for high-level planning
    const orchestratorResponse = await fetchAPIBackground(
      history, 
      userText, 
      userMsg.imageBase64 || null, 
      orchestratorPrompt, 
      'gemma-3-27b-it'
    );

    // Parse the JSON
    let tasks;
    try {
      const cleanJson = orchestratorResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      tasks = JSON.parse(cleanJson);
    } catch (e) {
      console.error("Orchestrator JSON parse error", e, orchestratorResponse);
      throw new Error("Orchestrator failed to generate a valid plan.");
    }

    if (!tasks || !tasks.taskA || !tasks.taskB) {
      throw new Error("Orchestrator response missing taskA or taskB.");
    }

    updateTerminal(terminalId, '> Orchestrator generated tasks. Dispatching to parallel workers...');
    
    // ═══════════════════════════════════════════════
    // PHASE 2: PARALLEL WORKERS (EXECUTION)
    // ═══════════════════════════════════════════════
    
    // Worker System Prompt
    const workerSystemPrompt = "You are a specialized worker node. Execute the following task perfectly. Adhere strictly to any variable names or IDs provided.";
    
    // Execute in parallel
    // Context Pruning: Send ONLY the specific task, no history
    const [resultA, resultB] = await Promise.all([
      fetchAPIBackground([], tasks.taskA, null, workerSystemPrompt, 'gemma-3-27b-it'),
      fetchAPIBackground([], tasks.taskB, null, workerSystemPrompt, 'gemma-3-27b-it')
    ]);

    updateTerminal(terminalId, '> Workers A and B have completed execution. Synthesizing final output...');

    // ═══════════════════════════════════════════════
    // PHASE 3: THE SYNTHESIZER (FINAL OUTPUT)
    // ═══════════════════════════════════════════════
    
    const synthesizerPrompt = 
      `You are the final compiler and Senior Code Reviewer. You have received components from two parallel workers. ` +
      `Stitch them into a single, flawless output for the user. ` +
      `**Crucially:** check for programmatic mismatches. Ensure all CSS classes, HTML IDs, and variables match perfectly. ` +
      `Fix any broken logic. Output the final, polished response directly to the user.`;

    const combinedInput = `
--- WORKER A OUTPUT ---
${resultA}

--- WORKER B OUTPUT ---
${resultB}
    `.trim();

    const finalResponse = await fetchAPIBackground(
      history,
      combinedInput,
      null,
      synthesizerPrompt,
      'gemma-3-27b-it'
    );

    // ═══════════════════════════════════════════════
    // FINALIZE
    // ═══════════════════════════════════════════════
    removeTerminal(terminalId);
    
    // Append the actual assistant message
    // We pass the finalResponse as content. The appendMessage function handles markdown parsing.
    appendMessage({ role: 'assistant', content: finalResponse, ts: Date.now() });

  } catch (err) {
    updateTerminal(terminalId, `> Error: ${err.message}`, true);
    toast(`Agent Mode Error: ${err.message}`, 'error');
    // We leave the error terminal up so the user knows what happened
    console.error(err);
  } finally {
    state.isStreaming = false;
    document.getElementById('send-btn').disabled = false;
  }
}

/**
 * "Silent" Fetch API that returns the full text string.
 * Uses standard JSON response (no SSE) for simplicity in background tasks.
 */
async function fetchAPIBackground(history, newUserText, imageBase64, systemPrompt, modelOverride) {
  const apiKey = LS.get('aura:apikey', '');
  if (!apiKey) throw new Error('No API key saved.');

  const model = modelOverride || 'gemma-3-27b-it';
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  // Explicitly cast to String to avoid "Starting an object on a scalar field" API error
  const safeText = String(newUserText || '');

  const parts = [{ text: safeText }];
  if (imageBase64) {
    let mimeType = 'image/jpeg';
    let data = imageBase64;
    const match = imageBase64.match(/^data:(image\/[^;]+);base64,(.+)/);
    if (match) { mimeType = match[1]; data = match[2]; }
    parts.push({ inlineData: { mimeType, data } });
  }

  const personaPrefix = systemPrompt
    ? [
        { role: 'user',  parts: [{ text: `[System Instructions] ${String(systemPrompt)}` }] },
        { role: 'model', parts: [{ text: 'Understood.' }] },
      ]
    : [];

  // Robust history mapping with String casting
  const formattedHistory = history.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '') }]
  }));

  const contents = [
    ...personaPrefix,
    ...formattedHistory,
    { role: 'user', parts }
  ];

  // Pull safety settings from defaults (or strict defaults for agents)
  // We want agents to be relatively unhindered to produce code, but still safe
  const safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  ];

  const body = {
    contents,
    safetySettings,
    generationConfig: { temperature: 0.9, maxOutputTokens: 8192 } // Higher token limit for agents
  };

  // Standard fetch (no sse)
  const res = await fetch(`${API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── TERMINAL BUBBLE UI HELPERS ──

function createTerminalBubble() {
  const id = 'term_' + Date.now();
  const container = document.getElementById('messages-container');
  const div = document.createElement('div');
  div.id = id;
  div.className = 'msg-group assistant';
  // Use a distinct mono style for terminal
  div.innerHTML = `
    <div class="msg-avatar ai" style="background:rgba(0,229,255,0.15); color:#00e5ff; border-color:rgba(0,229,255,0.3)">
      <i class="ph ph-terminal-window"></i>
    </div>
    <div class="msg-bubble" style="font-family:var(--mono); font-size:12px; color:#00e5ff; background:rgba(0,0,0,0.3); border:1px solid rgba(0,229,255,0.2);">
      <div class="term-content">> Initializing...</div>
    </div>`;
  container.appendChild(div);
  scrollBottom();
  return id;
}

function updateTerminal(id, text, isError = false) {
  const el = document.getElementById(id);
  if (!el) return;
  const content = el.querySelector('.term-content');
  if (content) {
    if (isError) content.style.color = 'var(--danger)';
    content.textContent = text;
  }
}

function removeTerminal(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}
