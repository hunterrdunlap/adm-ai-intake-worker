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
      const answeredQuestions = questions.filter(q => answers[q.key] && answers[q.key].text);
      const unansweredQuestions = questions.filter(q => !answers[q.key] || !answers[q.key].text);
      
      const prompt = `You are an AI assistant helping collect information about AI project ideas. Your job is to:
  
  1. Extract answers to specific questions from the user's messages.
  2. For each extracted answer, provide a quality score from 1 to 5 (1=very poor, 5=excellent).
  3. Determine which question should be focused on next.
  4. Generate a conversational response that feels natural. If an answer's quality is below 3, your response should aim to get more detailed information for that specific question.
  
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
  
  Please respond with a JSON object containing:
  {
    "extractedAnswers": {
      // Object with keys matching question.key.
      // Each value should be an object: { "text": "extracted answer", "quality": score (1-5) }
      // Only include answers that can be clearly extracted from the current message.
      // If one user message contains answers for MULTIPLE questions, extract ALL of them.
    },
    "response": "Your conversational response to the user. If any answer quality < 3, ask for more detail on that topic.",
    "currentFocus": "question_id of the next question to focus on (can be a low-quality one for clarification)",
    "allAnswered": boolean indicating if all questions have been answered with sufficient quality (e.g., quality >= 3)
  }
  
  Guidelines:
  - Be conversational and natural.
  - Don't list questions mechanically.
  - If multiple questions can be answered from one message, extract all of them with their quality.
  - Focus on the most important unanswered question OR a question that needs clarification due to low quality.
  - Acknowledge what the user shared before asking the next question or seeking clarification.
  - If the user provides vague answers, assign a lower quality score and politely ask for more detail.`;
  
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
      const { sessionId, chat, answers } = await request.json(); // answers is now { key: {text, quality} }
  
      // Prepare a summarized version of the chat history for the prompt
      const chatHistorySummary = chat.slice(-10).map(h => `${h.role}: ${h.text}`).join('\n');
  
      let prompt = "You are an AI assistant. Based on the following collected answers (text and quality) and a snippet of the conversation history about an AI project idea, please generate a concise and coherent narrative summary of the project. Focus on the content of the answers.\n\n";
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
      const { sessionId, answers, history, summary } = await request.json(); // answers now include quality
      
      // Here you would integrate with your storage solution
      // For now, we'll just log it and return success
      console.log('Storing idea (with quality):', { // Updated log
        sessionId,
        answers, // This now includes { text: "...", quality: X }
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