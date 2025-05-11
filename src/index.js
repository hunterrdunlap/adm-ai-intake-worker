// src/index.js
export default {
    async fetch(request, env) {
      const url = new URL(request.url);
      // Ensure the request is a POST request and to the /summarize path
      if (request.method !== "POST" || url.pathname !== "/summarize") {
        // Try to match the route pattern if your worker is on a subdomain
        // e.g. https://ai-intake.<YOUR_ACCOUNT>.workers.dev/summarize
        // Or if your route is just the root of your worker URL
        // e.g. https://ai-intake.<YOUR_ACCOUNT>.workers.dev/
        // For simplicity, let's assume /summarize is the path on the worker's deployed URL.
        // If using custom domains and routes, the original check is fine.
        // If deploying to *.workers.dev, the path will be relative to the worker's URL.
        // Let's adjust to be more flexible for *.workers.dev deployment initially
        if (request.method !== "POST") { // Simpler check for now
           return new Response("Not found. Expected POST.", { status: 404 });
        }
        // If you want to enforce the /summarize path strictly even on *.workers.dev:
        // if (request.method !== "POST" || (url.pathname !== "/summarize" && url.pathname !== "/")) {
        //   return new Response(`Not found. Path was ${url.pathname}. Expected POST to /summarize or /.`, { status: 404 });
        // }
      }
  
      try {
        const { chat, answers, sessionId } = await request.json();
  
        const prompt = `
  Summarize the following AI-idea interview in two paragraphs, then output:
  ---
  Business Unit:
  Category (tag):
  Urgency (high/med/low):
  ---
  Answers JSON:${JSON.stringify(answers, null, 2)}
  `;
  
        const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${env.OPENAI_KEY}`, // Access secret key from environment
          },
          body: JSON.stringify({
            model: "gpt-4o", // or your preferred model
            messages: [{ role: "user", content: prompt }],
          }),
        });
  
        if (!openaiResponse.ok) {
          const errorText = await openaiResponse.text();
          console.error("OpenAI API Error:", errorText);
          return new Response(`Upstream OpenAI error: ${openaiResponse.status} ${errorText}`, { status: 502 });
        }
  
        const data = await openaiResponse.json();
        if (!data.choices || data.choices.length === 0 || !data.choices[0].message) {
           console.error("OpenAI API returned unexpected data structure:", data);
           return new Response("Invalid response structure from OpenAI.", {status: 500 });
        }
        return Response.json({ summary: data.choices[0].message.content });
  
      } catch (e) {
        console.error("Error in Worker:", e.message);
        return new Response(`Error processing request: ${e.message}`, { status: 500 });
      }
    },
  };