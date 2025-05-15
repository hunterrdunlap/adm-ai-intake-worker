export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };
  
      // Handle CORS preflight requests
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 200, headers: corsHeaders });
      }
  
      // Route requests
      if (url.pathname === '/process' && request.method === 'POST') {
        return handleProcess(request, env, corsHeaders);
      }
      
      if (url.pathname === '/summarize' && request.method === 'POST') {
        return handleSummarize(request, env, corsHeaders);
      }
      
      if (url.pathname === '/store-idea' && request.method === 'POST') {
        return handleStoreIdea(request, env, corsHeaders);
      }

      if (url.pathname === '/admin/data' && request.method === 'GET') {
        return handleAdminData(request, env, corsHeaders);
      }
  
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    },
  };
  
  async function handleProcess(request, env, corsHeaders) {
    try {
      const { sessionId, clockId, message, history, answers, questions } = await request.json();
  
      // Create a dynamic prompt based on current state
      const answeredQuestions = questions.filter(q => answers[q.key] && answers[q.key].text);
      const unansweredQuestions = questions.filter(q => !answers[q.key] || !answers[q.key].text);
      
      const prompt = `You are an AI assistant helping collect information about AI project ideas. Your job is to:
  
  1. Extract answers to specific questions from the user's messages.
  2. For each extracted answer, provide a quality score from 1 to 5 (1=very poor, 5=excellent).
  3. Determine which question should be focused on next.
  4. Generate a concise response. Ask the next most relevant unanswered question. If an answer's quality for a *previously answered question* is < 3, your response should aim to get more detailed information for *that specific question* instead of moving to a new one. Do not repeat the user's previous message or offer preamble like 'Okay, I understand that...'.
  
  Current state:
  - Answered questions: ${answeredQuestions.map(q => `${q.text} (Quality: ${answers[q.key] ? answers[q.key].quality : 'N/A'})`).join(', ')}
  - Unanswered questions: ${unansweredQuestions.map(q => q.text).join(', ')}
  
  User's message: "${message}"
  
  Recent conversation history:
  ${history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n')}
  
  Questions to extract answers for (provide text and quality for each):
  ${questions.map(q => `${q.id} (${q.key}): ${q.text}`).join('\n')}
  
  Current answers (with quality scores):
  ${JSON.stringify(answers, null, 2)}
  
  Clock ID of the user: ${clockId}
  
  Please respond with a JSON object containing:
  {
    "extractedAnswers": {
      // Object with keys matching question.key.
      // Each value should be an object: { "text": "extracted answer", "quality": score (1-5) }
      // Only include answers that can be clearly extracted from the current message.
      // If one user message contains answers for MULTIPLE questions, extract ALL of them.
    },
    "response": "Your concise response to the user. Directly ask the next most relevant unanswered question. If an answer's quality for a *previously answered question* is < 3, ask for more specific detail on that topic instead of moving to a new question. Do not repeat the user's previous message or offer preamble like 'Okay, I understand that...'.",
    "currentFocus": "question_id of the next question to focus on (can be a low-quality one for clarification)",
    "allAnswered": boolean indicating if all questions have been answered with sufficient quality (e.g., quality >= 3)
  }
  
  Guidelines:
  - Be direct and to the point in your responses.
  - Don't list questions mechanically.
  - If multiple questions can be answered from one message, extract all of them with their quality.
  - Focus on the most important unanswered question OR a question that needs clarification due to low quality. If clarifying, be specific about what additional detail is needed.
  - Do NOT acknowledge or repeat what the user just said. Directly ask the next question or ask for clarification concisely.
  - If the user provides vague answers, assign a lower quality score and politely ask for more specific detail for that question.
  - For the "What makes this a good candidate for AI?" question (aiCandidacy), be generous with the quality score. Even basic or brief answers should receive at least a 3. Any mention of automation, data processing, pattern recognition, prediction, or similar AI capabilities should be considered more than satisfactory.`;
  
      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          response_format: { type: "json_object" }
        }),
      });
  
      if (!openaiResponse.ok) {
        const errorBody = await openaiResponse.text();
        console.error(`OpenAI API error: ${openaiResponse.status} ${openaiResponse.statusText}`, errorBody);
        throw new Error(`OpenAI API error: ${openaiResponse.status} ${openaiResponse.statusText}`);
      }
  
      const data = await openaiResponse.json();
      const assistantResponse = data.choices[0].message.content;
      
      // It's still a good idea to log the raw response when debugging
      console.log("Raw OpenAI Response (should be JSON):", assistantResponse);

      // Parse the JSON response
      let parsedResponse;
      try {
        parsedResponse = JSON.parse(assistantResponse);
      } catch (e) {
        console.error('Failed to parse OpenAI JSON response:', e);
        console.error('Raw response that failed parsing:', assistantResponse);
        // Fallback if JSON parsing fails
        parsedResponse = {
          extractedAnswers: {},
          response: "I understand you're sharing information about your AI idea. Could you tell me more about the specific business problem you're trying to solve?",
          currentFocus: questions[0].id, // Default to the first question
          allAnswered: false
        };
      }
  
      // Validate that all questions are answered with at least quality 3
      // Update existing answers with new ones before checking
      const tempAnswers = JSON.parse(JSON.stringify(answers)); // Deep clone
      if (parsedResponse.extractedAnswers) {
        for (const key in parsedResponse.extractedAnswers) {
          if (parsedResponse.extractedAnswers.hasOwnProperty(key)) {
            tempAnswers[key] = parsedResponse.extractedAnswers[key];
          }
        }
      }
      
      parsedResponse.allAnswered = questions.every(q => 
        tempAnswers[q.key] && tempAnswers[q.key].text && tempAnswers[q.key].quality >= 3
      );
  
      return new Response(JSON.stringify(parsedResponse), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
  
    } catch (error) {
      console.error('Error processing request:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
  
  async function handleSummarize(request, env, corsHeaders) {
    try {
      const { sessionId, clockId, chat, answers } = await request.json();
  
      // Prepare a summarized version of the chat history for the prompt
      const chatHistorySummary = chat.slice(-10).map(h => `${h.role}: ${h.text}`).join('\n');
  
      let prompt = "You are an AI assistant. Based on the following collected answers (text and quality) and a snippet of the conversation history about an AI project idea, please generate a concise and coherent narrative summary of the project. Focus on the content of the answers.\n\n";
      prompt += `User Clock ID: ${clockId}\n`;
      prompt += "Collected Answers:\n";
      // Extract text from answers for the prompt
      const answersForPrompt = {};
      for (const key in answers) {
        if (answers.hasOwnProperty(key) && answers[key].text) {
          answersForPrompt[key] = answers[key].text; // Only include text for summary prompt
        }
      }
      prompt += JSON.stringify(answersForPrompt, null, 2) + "\n\n";
      prompt += "Conversation History (last 10 messages):\n";
      prompt += chatHistorySummary + "\n\n";
      prompt += "Please provide a narrative summary of the AI project idea. Output only the summary text itself, without any leading phrases like \"Here's the summary:\".";
  
      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4.1",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.5, 
          // No response_format needed, as we want plain text
        }),
      });
  
      if (!openaiResponse.ok) {
        const errorBody = await openaiResponse.text(); // Get more details on the error
        console.error(`OpenAI API error during summarize: ${openaiResponse.status} ${openaiResponse.statusText}`, errorBody);
        throw new Error(`OpenAI API error: ${openaiResponse.status} ${openaiResponse.statusText}`);
      }
  
      const data = await openaiResponse.json();
      
      if (!data.choices || !data.choices[0] || !data.choices[0].message || typeof data.choices[0].message.content !== 'string') {
        console.error('Unexpected OpenAI response structure:', data);
        throw new Error('Failed to get summary from OpenAI response.');
      }
      
      const summaryText = data.choices[0].message.content;
  
      return new Response(JSON.stringify({ summary: summaryText }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
  
    } catch (error) {
      console.error('Error generating summary:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
  
  async function handleStoreIdea(request, env, corsHeaders) {
    try {
      const { sessionId, clockId, answers, summary } = await request.json(); // Removed 'history' as it's not stored

      // Define the question keys in the order they appear in your CREATE TABLE statement
      // This ensures the bindings are correct.
      const questionKeys = [
        'taskToImprove', 'currentProcess', 'timeEffort', 'benefitingTeam',
        'successMeasurement', 'dataSources', 'unintendedOutcomes', 'aiCandidacy'
      ];

      const sql = `
        INSERT INTO project_ideas (
          sessionId, clockId, summary,
          taskToImprove_text, taskToImprove_quality,
          currentProcess_text, currentProcess_quality,
          timeEffort_text, timeEffort_quality,
          benefitingTeam_text, benefitingTeam_quality,
          successMeasurement_text, successMeasurement_quality,
          dataSources_text, dataSources_quality,
          unintendedOutcomes_text, unintendedOutcomes_quality,
          aiCandidacy_text, aiCandidacy_quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
      `;

      // Prepare the values for binding
      // The order must match the '?' placeholders in the SQL statement
      const bindings = [
        sessionId,          // sessionId
        clockId,            // clockId
        summary             // summary
      ];

      questionKeys.forEach(key => {
        const answer = answers[key];
        bindings.push(answer && answer.text ? answer.text : null);         // _text
        bindings.push(answer && typeof answer.quality === 'number' ? answer.quality : null); // _quality
      });

      // Ensure we have the correct number of bindings
      // 1 (sessionId) + 1 (clockId) + 1 (summary) + 8 questions * 2 fields/question = 3 + 16 = 19 expected after summary
      // Total placeholders: 2 (session, clock) + 1 (summary) + 16 (questions) = 19 in total.
      // My SQL has 20 '?' placeholders, 1 for sessionId, 1 for clockId, 1 for summary, then 16 for questions (8*2)
      // No, the SQL has: sessionId, clockId, summary (3) + 8*2 = 16. Total = 19 placeholders.
      // My values array: sessionId, clockId, summary (3) + 8*2 = 16. Total = 19.
      // Correcting the SQL above. It should be 19 placeholders.
      // sessionId, clockId, summary,
      // q1_text, q1_quality,
      // q2_text, q2_quality,
      // ...
      // q8_text, q8_quality
      // SQL has: 1 (sessionId) + 1 (clockId) + 1 (summary) + 8*2 (16 for questions) = 19 placeholders.
      // The bindings array starts with 3 elements and then adds 16. So, 19 total. This matches.

      // console.log('Attempting to store idea with D1. Bindings:', bindings);
      // console.log('Number of bindings:', bindings.length);

      const stmt = env.DB.prepare(sql).bind(...bindings);
      const { success, error } = await stmt.run();

      if (success) {
        console.log('Idea stored successfully in D1:', { sessionId, clockId });
        return new Response(JSON.stringify({
          success: true,
          message: 'Idea stored successfully'
        }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } else {
        console.error('Failed to store idea in D1:', error, { sessionId, clockId });
        return new Response(JSON.stringify({
          success: false,
          message: 'Failed to store idea in database.',
          error: error || 'Unknown D1 error'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

    } catch (error) {
      console.error('Error in handleStoreIdea function:', error);
      // Check if it's a D1 specific error structure or general error
      const errorMessage = error.message || (error.cause ? error.cause.message : 'Internal server error');
      const errorStack = error.stack || '';
      console.error('Full error details:', { errorMessage, errorStack, cause: error.cause });

      return new Response(JSON.stringify({
        error: 'An error occurred while attempting to store the idea.',
        detail: errorMessage
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }

  async function handleAdminData(request, env, corsHeaders) {
    try {
      // Check for Authorization header
      const authHeader = request.headers.get('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({
          error: "Unauthorized. Missing or invalid token."
        }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      // Extract and validate token
      const token = authHeader.replace('Bearer ', '');
      
      try {
        // In a real app, you'd properly verify the JWT
        // This is a simple check for demonstration purposes
        const decoded = atob(token);
        const [storedPassword, timestamp] = decoded.split(':');
        
        // Check if the password in the token matches and if the token is not too old (24 hour expiry)
        const isValid = 
          storedPassword === env.ADMIN_PASSWORD && 
          (Date.now() - parseInt(timestamp)) < 24 * 60 * 60 * 1000;
        
        if (!isValid) {
          return new Response(JSON.stringify({
            error: "Unauthorized. Token expired or invalid."
          }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      } catch (e) {
        return new Response(JSON.stringify({
          error: "Unauthorized. Invalid token format."
        }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
  
      const sql = "SELECT * FROM project_ideas;";
      const stmt = env.DB.prepare(sql);
      const { results, success, error } = await stmt.all();
  
      if (success && results) {
        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } else {
        console.error('Failed to fetch data for admin panel:', error);
        return new Response(JSON.stringify({
          success: false,
          message: 'Failed to fetch data from database.',
          error: error || 'Unknown D1 error fetching admin data'
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    } catch (error) {
      console.error('Error in handleAdminData function:', error);
      return new Response(JSON.stringify({
        error: 'An error occurred while attempting to fetch admin data.',
        detail: error.message
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
  
  // Add the new handleAdminAuth function
  async function handleAdminAuth(request, env, corsHeaders) {
    try {
      // Parse request body
      const { password } = await request.json();
      
      // Check if password is correct
      if (!password || password !== env.ADMIN_PASSWORD) {
        return new Response(JSON.stringify({
          error: "Invalid credentials."
        }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      
      // Create a simple token (in a real app, you'd use JWT with proper signing)
      // This is a basic implementation for demonstration
      const token = btoa(`${password}:${Date.now()}`);
      
      // Return the token
      return new Response(JSON.stringify({
        token: token
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Error in handleAdminAuth function:', error);
      return new Response(JSON.stringify({
        error: 'Authentication failed.'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
  
  // Somewhere in the main fetch function, add this condition
  if (url.pathname === '/admin/auth' && request.method === 'POST') {
    return handleAdminAuth(request, env, corsHeaders);
  } 