import OpenAI from "openai";
import sql from "../configs/db.js";
import { clerkClient } from "@clerk/express";
import { v2 as cloudinary } from 'cloudinary';
import axios from "axios";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PDFParse } = require("pdf-parse");

const AI = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

const AI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const getErrorDetails = async (error) => {
    const details = {
        message: error?.message || "AI request failed",
        status: error?.status || error?.response?.status || 500,
    };

    try {
        if (typeof error?.response?.text === "function") {
            const bodyText = await error.response.text();
            if (bodyText) details.providerBody = bodyText;
        }
    } catch {
        // Ignore secondary parsing failures while handling the primary error.
    }

    if (!details.providerBody && error?.response?.data) {
        const responseData = error.response.data;

        if (Buffer.isBuffer(responseData)) {
            details.providerBody = responseData.toString("utf-8");
        } else if (typeof responseData === "string") {
            details.providerBody = responseData;
        } else {
            details.providerBody = JSON.stringify(responseData);
        }
    }

    if (!details.providerBody && error?.error) {
        details.providerBody =
            typeof error.error === "string" ? error.error : JSON.stringify(error.error);
    }

    if (error?.code) details.code = error.code;

    return details;
};

const saveCreation = async ({ userId, prompt, content, type, publish = false }) => {
    try {
        await sql`
            INSERT INTO creations (user_id, prompt, content, type, publish)
            VALUES (${userId}, ${prompt}, ${content}, ${type}, ${publish})
        `;
    } catch (error) {
        if (error?.code === "42703" && error?.message?.includes('"publish"')) {
            try {
                await sql`
                    INSERT INTO creations (user_id, prompt, content, type)
                    VALUES (${userId}, ${prompt}, ${content}, ${type})
                `;
                return;
            } catch (innerError) {
                if (innerError?.code === "42703" && innerError?.message?.includes('"type"')) {
                    await sql`
                        INSERT INTO creations (user_id, prompt, content)
                        VALUES (${userId}, ${prompt}, ${content})
                    `;
                    return;
                }

                throw innerError;
            }
        }

        if (error?.code === "42703" && error?.message?.includes('"type"')) {
            try {
                await sql`
                    INSERT INTO creations (user_id, prompt, content, publish)
                    VALUES (${userId}, ${prompt}, ${content}, ${publish})
                `;
                return;
            } catch (innerError) {
                if (innerError?.code === "42703" && innerError?.message?.includes('"publish"')) {
                    await sql`
                        INSERT INTO creations (user_id, prompt, content)
                        VALUES (${userId}, ${prompt}, ${content})
                    `;
                    return;
                }

                throw innerError;
            }
        }

        throw error;
    }
};

const parseBlogTitlesFromContent = (content) => {
    const raw = String(content || "").trim();

    if (!raw) return [];

    const cleaned = raw
        .replace(/```json|```/gi, "")
        .trim();

    const normalized = (() => {
        const start = cleaned.indexOf("[");
        const end = cleaned.lastIndexOf("]");

        if (start !== -1 && end !== -1 && end > start) {
            return cleaned.slice(start, end + 1);
        }

        return cleaned;
    })();

    try {
        const parsed = JSON.parse(normalized);
        if (Array.isArray(parsed)) {
            return parsed
                .map((item) => String(item || "").trim())
                .filter(Boolean)
                .slice(0, 6);
        }
    } catch {
        // Fall through to tolerant parsing below.
    }

    const quotedMatches = [...normalized.matchAll(/"([^"]+)"/g)]
        .map((match) => match[1].trim())
        .filter(Boolean);

    if (quotedMatches.length > 0) {
        return quotedMatches.slice(0, 6);
    }

    return normalized
        .split(/\r?\n|,(?=\s*")/)
        .map((item) => item
            .replace(/^\s*(?:[-*]|\d+[\.\)])\s*/, "")
            .replace(/^[\[\s"]+|[\]\s",]+$/g, "")
            .trim())
        .filter(Boolean)
        .slice(0, 6);
};

export const generateArticle = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { prompt, length } = req.body;
        const plan = req.plan;
        const free_usage = req.free_usage;

        if (plan !== 'premium' && free_usage >= 10) {
            return res.json({ success: false, message: "Limit reached. Upgrade to continue." })
        }

        if (!prompt?.trim()) {
            return res.status(400).json({ success: false, message: "Prompt is required." });
        }

        const response = await AI.chat.completions.create({
            model: AI_MODEL,
            messages: [
                {
                    role: "user",
                    content: prompt.trim(),
                },
            ],
            temperature: 0.7,
            max_tokens: Math.ceil(Number(length) * 3) ,
        });

        const content = response.choices?.[0]?.message?.content;

        if (!content) {
            return res.status(502).json({
                success: false,
                message: "AI provider returned an empty response.",
            });
        }

        await saveCreation({
            userId,
            prompt,
            content,
            type: "article",
        });

        if (plan !== 'premium') {
            await clerkClient.users.updateUserMetadata(userId, {
                privateMetadata: {
                    free_usage: free_usage + 1
                }
            })
        }

        res.json({ success: true, content });

    } catch (error) {
        const details = await getErrorDetails(error);
        console.log("generateArticle failed:", details);

        res.status(details.status >= 400 ? details.status : 500).json({
            success: false,
            message: details.message,
            status: details.status,
            code: details.code,
            providerBody: details.providerBody,
        });

    }
}

export const generateBlogTitle = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { prompt, keyword, category } = req.body;
        const plan = req.plan;
        const free_usage = req.free_usage;

        if (plan !== 'premium' && free_usage >= 10) {
            return res.json({ success: false, message: "Limit reached. Upgrade to continue." })
        }

        const cleanKeyword = (keyword || prompt || '').toString().trim();
        const cleanCategory = (category || 'General').toString().trim();

        if (!cleanKeyword) {
            return res.status(400).json({ success: false, message: "Keyword is required." });
        }

        const finalPrompt =
            `Generate exactly 6 catchy blog post titles for the topic "${cleanKeyword}" in the "${cleanCategory}" category.\n` +
            `Return a valid JSON array of strings only.\n` +
            `Rules:\n` +
            `- Return exactly 6 titles.\n` +
            `- No markdown, no code fences, no explanation text.\n` +
            `- Each title must be complete and no longer than 14 words.`;

        const response = await AI.chat.completions.create({
            model: AI_MODEL,
            messages: [
                {
                    role: 'system',
                    content: 'You write concise, complete blog titles and follow formatting instructions exactly.',
                },
                {
                    role: 'user',
                    content: finalPrompt,
                },
            ],
            temperature: 0.7,
            max_tokens: 500,
        });

        console.log('generateBlogTitle prompt:', finalPrompt);
        console.log('generateBlogTitle raw response:', JSON.stringify(response?.choices?.[0]?.message?.content));

        const content = response.choices?.[0]?.message?.content;

        if (!content) {
            return res.status(502).json({
                success: false,
                message: "AI provider returned an empty response.",
            });
        }

        const titles = parseBlogTitlesFromContent(content);

        if (titles.length === 0) {
            return res.status(502).json({
                success: false,
                message: "Could not parse titles from AI response.",
            });
        }

        await saveCreation({
            userId,
            prompt: cleanKeyword,
            content,
            type: "blog-title",
        });

        if (plan !== 'premium') {
            await clerkClient.users.updateUserMetadata(userId, {
                privateMetadata: {
                    free_usage: free_usage + 1
                }
            })
        }

        res.json({ success: true, content, titles });

    } catch (error) {
        const details = await getErrorDetails(error);
        console.log("generateBlogTitle failed:", details);

        res.status(details.status >= 400 ? details.status : 500).json({
            success: false,
            message: details.message,
            status: details.status,
            code: details.code,
            providerBody: details.providerBody,
        });

    }
}

export const generateImage = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { prompt, publish } = req.body;
        const plan = req.plan;

        if (plan !== 'premium') {
            return res.json({ success: false, message: "This feature is only available for premium users." })
        }

        if (!prompt?.trim()) {
            return res.status(400).json({ success: false, message: "Prompt is required." });
        }

        const formData = new FormData();
        formData.append('prompt', prompt.trim());
        const { data } = await axios.post("https://clipdrop-api.co/text-to-image/v1", formData, {
            headers: {
                'x-api-key': process.env.CLIPDROP_API_KEY,
                ...formData.getHeaders?.(),
            },
            responseType: "arraybuffer",
        })

        const base64Image = `data:image/png;base64,${Buffer.from(data, 'binary').toString('base64')}`;

        const { secure_url } = await cloudinary.uploader.upload(base64Image)

        await saveCreation({
            userId,
            prompt,
            content: secure_url,
            type: "image",
            publish: publish || false,
        });

        res.json({ success: true, content: secure_url });

    } catch (error) {
        const details = await getErrorDetails(error);
        console.log("generateImage failed:", details);

        res.status(details.status >= 400 ? details.status : 500).json({
            success: false,
            message: details.message,
            status: details.status,
            code: details.code,
            providerBody: details.providerBody,
        });

    }
}

export const removeImageBackground = async (req, res) => {
    try {
        const { userId } = req.auth();
        const image = req.file;
        const plan = req.plan;

        if (plan !== 'premium') {
            return res.json({ success: false, message: "This feature is only available for premium users." })
        }

        if (!image) {
            return res.status(400).json({ success: false, message: "Image file is required." });
        }

        const base64Image = `data:${image.mimetype};base64,${image.buffer.toString('base64')}`;

        const { secure_url } = await cloudinary.uploader.upload(base64Image, {
            transformation: [
                {
                    effect: "background_removal",
                    background_removal: 'remove_the_background'
                }
            ]
        })

        await saveCreation({
            userId,
            prompt: "Remove background from image",
            content: secure_url,
            type: "image",
        });

        res.json({ success: true, content: secure_url });

    } catch (error) {
        const details = await getErrorDetails(error);
        console.log("generateImage failed:", details);

        res.status(details.status >= 400 ? details.status : 500).json({
            success: false,
            message: details.message,
            status: details.status,
            code: details.code,
            providerBody: details.providerBody,
        });

    }
}

export const removeImageObject = async (req, res) => {
    try {
        const { userId } = req.auth();
        const { object } = req.body;
        const image = req.file;
        const plan = req.plan;

        if (plan !== 'premium') {
            return res.json({ success: false, message: "This feature is only available for premium users." })
        }

        if (!image) {
            return res.status(400).json({ success: false, message: "Image file is required." });
        }

        if (!object?.trim()) {
            return res.status(400).json({ success: false, message: "Object is required." });
        }

        const base64Image = `data:${image.mimetype};base64,${image.buffer.toString('base64')}`;

        const { public_id } = await cloudinary.uploader.upload(base64Image)

        const imageUrl = cloudinary.url(public_id, {
            transformation: [{ effect: `gen_remove:${object.trim()}` }],
            resource_type: "image",
        })

        await saveCreation({
            userId,
            prompt: `Remove ${object} from image`,
            content: imageUrl,
            type: "image",
        });

        res.json({ success: true, content: imageUrl });

    } catch (error) {
        const details = await getErrorDetails(error);
        console.log("generateImage failed:", details);

        res.status(details.status >= 400 ? details.status : 500).json({
            success: false,
            message: details.message,
            status: details.status,
            code: details.code,
            providerBody: details.providerBody,
        });

    }
}
export const resumeReview = async (req, res) => {
    try {
        const { userId } = req.auth();
        const resume = req.file;
        const plan = req.plan;

        if (plan !== 'premium') {
            return res.json({ success: false, message: "This feature is only available for premium users." })
        }

        if (!resume) {
            return res.status(400).json({ success: false, message: "Resume file is required." });
        }

        if (resume.size > 5 * 1024 * 1024) {
            return res.json({ success: false, message: "File size should be less than 5MB." })
        }

        const parser = new PDFParse({ data: resume.buffer });
        const pdfData = await parser.getText();
        await parser.destroy();

        const prompt = `You are an expert resume reviewer and technical hiring coach.

Review the resume below and provide a detailed, constructive analysis in markdown.

Your response must include these sections:
1. Overall Assessment
2. Key Strengths
3. Main Weaknesses
4. Content Improvements
5. Formatting and Structure Suggestions
6. ATS Optimization Tips
7. Suggested Resume Summary
8. Final Action Plan

Requirements:
- Be specific and practical.
- Give at least 3-5 points in each major section where relevant.
- Suggest stronger bullet points when the resume content is vague.
- Mention missing metrics, impact, action verbs, and role-specific keywords.
- Focus on improving the resume for software engineering or full stack developer roles when applicable.
- Keep the tone encouraging but honest.
- Return a detailed response, not a short summary.
- Write at least 1500 words.
- Each section should be fully developed and useful on its own.

Resume Content:

${pdfData.text}`;

        const response = await AI.chat.completions.create({
            model: AI_MODEL,
            messages: [
                {
                    role: "user",
                    content: prompt,
                },
            ],
            temperature: 0.7,
            max_tokens: 3600,
        });

        let content = response.choices[0].message.content || "";

        if (content.trim().split(/\s+/).length < 1500) {
            const expandResponse = await AI.chat.completions.create({
                model: AI_MODEL,
                messages: [
                    {
                        role: "user",
                        content: `${prompt}

Below is an initial draft of the review:

${content}

Expand and improve this draft significantly.
- Keep the same sections.
- Add more concrete detail, examples, and actionable recommendations.
- Make the review comprehensive and substantially longer.
- Ensure the final review is at least 1500 words.
- Do not shorten existing useful content.
- Return the full improved review in markdown.`,
                    },
                ],
                temperature: 0.7,
                max_tokens: 3600,
            });

            content = expandResponse.choices[0].message.content || content;
        }

        await saveCreation({
            userId,
            prompt: `Review the uploaded resume`,
            content: content,
            type: "resume-review",
        });

        res.json({ success: true, content: content });

    } catch (error) {
        const details = await getErrorDetails(error);
        console.log("resumeReview failed:", details);

        res.status(details.status >= 400 ? details.status : 500).json({
            success: false,
            message: details.message,
            status: details.status,
            code: details.code,
            providerBody: details.providerBody,
        });

    }
}
