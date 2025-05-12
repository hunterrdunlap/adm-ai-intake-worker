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
  
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    },
  };
  
  async function handleProcess(request, env, corsHeaders) {
    try {
      const { sessionId, message, history, answers, questions } = await request.json();
  
      // Create a dynamic prompt based on current state
      const answeredQuestions = questions.filter(q => answers[q.key]);
      const unansweredQuestions = questions.filter(q => !answers[q.key]);
      
      const prompt = `You are an AI assistant helping collect information about AI project ideas. Your job is to:
  
  1. Extract answers to specific questions from the user's messages
  2. Determine which question should be focused on next
  3. Generate a conversational response that feels natural
  
  Current state:
  - Answered questions: ${answeredQuestions.map(q => q.text).join(', ')}
  - Unanswered questions: ${unansweredQuestions.map(q => q.text).join(', ')}
  
  User's message: "${message}"
  
  Recent conversation history:
  ${history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n')}
  
  Questions to extract answers for:
  ${questions.map(q => `${q.id} (${q.key}): ${q.text}`).join('\n')}
  
  Current answers:
  ${JSON.stringify(answers, null, 2)}
  
  Please respond with a JSON object containing:
  {
    "extractedAnswers": {
      // Object with keys matching question.key values and extracted answers
      // Only include answers that can be clearly extracted from the current message
    },
    "response": "Your conversational response to the user",
    "currentFocus": "question_id of the next question to focus on",
    "allAnswered": boolean indicating if all questions have been answered
  }
  
  Guidelines:
  - Be conversational and natural
  - Don't list questions mechanically
  - If multiple questions can be answered from one message, extract all of them
  - Focus on the most important unanswered question
  - Acknowledge what the user shared before asking the next question
  - If the user provides vague answers, politely ask for more detail`;
  
      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
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
          currentFocus: questions[0].id,
          allAnswered: false
        };
      }
  
      // Validate that all questions are answered
      parsedResponse.allAnswered = questions.every(q => 
        answers[q.key] || parsedResponse.extractedAnswers[q.key]
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
      const { sessionId, chat, answers } = await request.json();
  
      const prompt = `You are an AI assistant helping collect information about AI project ideas. Your job is to:

1. Extract answers to specific questions from the user's messages.
2. Determine which question should be focused on next.
3. Generate a conversational response that feels natural.

Current state:
- Answered questions (text only): ${answeredQuestions.map(q => q.text).join(', ') || 'None yet'}
- Unanswered questions (text only): ${unansweredQuestions.map(q => q.text).join(', ') || 'All questions appear to have some answer.'}

User's message: "${message}"

Recent conversation history:
${history.slice(-6).map(h => `${h.role}: ${h.text}`).join('\n')}

Questions to address (IMPORTANT: In your "extractedAnswers" JSON response, you MUST use the 'key_for_json' value shown for each question below as the actual key in the JSON object, for example, 'businessProblem', 'targetUsers'):
${questions.map(q => `- Question: "${q.text}" (key_for_json: '${q.key}', id_for_focus: '${q.id}')`).join('\n')}

Current answers already collected by the system (These are for your context to understand what has been gathered. Your 'extractedAnswers' for the current user message must still use the 'key_for_json' from the list above):
${JSON.stringify(answers, null, 2)}

Please respond with a JSON object strictly adhering to this structure:
{
  "extractedAnswers": {
    // IMPORTANT: Keys in this object MUST be the 'key_for_json' values specified in "Questions to address" (e.g., "businessProblem": "extracted answer...", "targetUsers": "extracted answer...").
    // Only include answers that can be clearly extracted from the LATEST user message. If no answer for a specific key is in the latest message, do not include that key.
  },
  "response": "Your conversational response to the user. Acknowledge their input and, if appropriate, ask the next logical question or guide them.",
  "currentFocus": "The 'id_for_focus' of the next most important UNANSWERED question (e.g., 'problem', 'users'). This should be one of the 'id_for_focus' values from the 'Questions to address' list.",
  "allAnswered": boolean // Set to true if you believe, based on the conversation and extracted answers, that all questions in the "Questions to address" list now have a satisfactory answer. Otherwise, set to false.
}

Guidelines:
- Be conversational and natural.
- Do not list questions mechanically in your response.
- If multiple questions can be answered from one user message, extract all of them using their respective 'key_for_json'.
- Focus on the most important unanswered question when determining 'currentFocus'.
- Acknowledge what the user shared before asking the next question.
- If the user provides vague answers, politely ask for more detail.`;
  
      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{ role: "user", content: prompt }],
        }),
      });
  
      if (!openaiResponse.ok) {
        throw new Error(`OpenAI API error: ${openaiResponse.status}`);
      }
  
      const data = await openaiResponse.json();
      
      return new Response(JSON.stringify({ summary: data.choices[0].message.content }), {
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
      const { sessionId, answers, history, summary } = await request.json();
      
      // Here you would integrate with your storage solution
      // For now, we'll just log it and return success
      console.log('Storing idea:', {
        sessionId,
        answers,
        timestamp: new Date().toISOString(),
        summary
      });
  
      // You could integrate with:
      // - Airtable API
      // - Google Sheets API
      // - Cloudflare D1 database
      // - Supabase
      // - Or any other storage service
  
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Idea stored successfully' 
      }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
  
    } catch (error) {
      console.error('Error storing idea:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }