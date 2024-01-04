import express from "express";
import { google, Auth } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import expressSession from "express-session";
import dotenv from "dotenv";

dotenv.config();

const SESSION_SECRET = process.env.SESSION_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3000/auth/callback/google";

interface SessionData {
    tokens?: Auth.Credentials;
}

declare module "express-session" {
    interface Session {
        tokens?: Auth.Credentials;
    }
}

const app = express();

// ---------------------- AUTH --------------------------------------------

// creating a session to store loggedIn user using express-session
app.use(
    expressSession({
        secret: SESSION_SECRET!,
        resave: true,
        saveUninitialized: true,
        cookie: {
            maxAge: 3 * 24 * 60 * 60 * 1000,
        },
    })
);

const oAuth2Client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

app.get("/", (req, res) => {
    const tokens = req.session.tokens as Auth.Credentials;
    if (tokens) res.redirect("/user");
    res.send("<a href='/login'>Login</a>");
});

//login route
app.get("/login", (req, res) => {
    try {
        const authUrl = oAuth2Client.generateAuthUrl({
            access_type: "offline",
            scope: [
                "https://www.googleapis.com/auth/gmail.modify",
                "https://www.googleapis.com/auth/userinfo.profile",
                "https://www.googleapis.com/auth/gmail.send",
                "https://www.googleapis.com/auth/userinfo.email",
            ],
        });
        res.redirect(authUrl);
    } catch (error: any) {
        console.log(error);
        return res.status(500).json({ message: error.message });
    }
});

// callback url after user is loggedin
app.get("/auth/callback/google", async (req, res) => {
    const { code } = req.query;

    if (!code) return res.status(401).json({ message: "unauthorized user" });

    try {
        const { tokens } = await oAuth2Client.getToken(code as string);
        oAuth2Client.setCredentials(tokens);

        // storing user info in our session
        req.session.tokens = tokens;
        app.locals.tokens = tokens;
        res.redirect("/user");
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: "internal error" });
    }
});

app.get("/user", async (req, res) => {
    const tokens = req.session.tokens as Auth.Credentials;
    if (!tokens) return res.status(401).json({ message: "unauthorized user" });

    try {
        const googleApi = google.people({ version: "v1", auth: oAuth2Client });
        const { data } = await googleApi.people.get({
            resourceName: "people/me",
            personFields: "names",
        });

        const userName = data.names?.[0]?.displayName || "Unknown User";

        res.status(200).send(`<h1>Welcome ${userName}</h1> <a href='/logout'>LogOut</a> `);
    } catch (error) {
        console.log(error);
        res.status(500).json({ message: "internal error" });
    }
});

app.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect("/");
    });
});

// --------------------------------- AUTH END ---------------------------------------------------------------------------------------------------

// ------------------------------- GMAIL OPERATION ----------------------------------------------------------------------------------------------
const gmail = google.gmail({ version: "v1", auth: oAuth2Client });

const repliedMailMap = new Map();

async function checkNewMails() {
    console.log("Fetching New Mails in ever 45 to 120 seconds");
    const tokens = app.locals.tokens as Auth.Credentials;
    if (!tokens) return null;

    try {
        const res = await gmail.users.messages.list({
            userId: "me",
            labelIds: ["INBOX"],
        });
        const message = res.data.messages;
        if (!message) return null;

        for (const msg of message) {
            const threadId = msg.threadId;
            const messageId = msg.id;

            if (threadId && messageId && !repliedMailMap.has(threadId)) {
                await sendReply(threadId, messageId);
                repliedMailMap.set(threadId, true);
            }
        }
    } catch (error) {
        console.log(error);
        console.log("Error in mail checking");
    }
}

async function sendReply(threadId: string, messageId: string) {
    try {
        const thredRes = await gmail.users.threads.get({
            userId: "me",
            id: threadId,
        });

        const hasReplied = thredRes.data.messages && thredRes.data.messages.length > 1;
        console.log(hasReplied);
        if (hasReplied) {
            return null;
        }

        // Fetch the original message
        const originalMessage = await gmail.users.messages.get({
            userId: "me",
            id: messageId,
        });
        if (!originalMessage.data.payload) {
            console.log("no payload data found");
            return null;
        }
        const headers = originalMessage.data.payload.headers;

        if (!headers) {
            console.log("No headers found in the original message payload");
            return null;
        }

        // fetching subject from original message
        const subjectHeader = headers.find((header) => header.name === "Subject");
        const subject = subjectHeader ? subjectHeader.value : "No Subject";

        // Extract the recipient email address from the original message
        const toHeader = headers.find((header) => header.name === "To");
        const toAddress = toHeader ? toHeader.value : "";

        // extracting senders mail
        const fromHeader = headers.find((header) => header.name === "From");
        const fromAddress = fromHeader ? fromHeader.value : "";

        if (!toAddress) return null;
        if (!fromAddress) return null;

        // fetching current user
        const googleApi = google.people({ version: "v1", auth: oAuth2Client });
        const { data } = await googleApi.people.get({
            resourceName: "people/me",
            personFields: "names",
        });

        const userName = data.names?.[0]?.displayName || "Unknown User";
        const replyText = `Thankyou for contacting ${userName}. You will be reached shortly`;

        const replyMessage =
            `From: "${userName}" <${toAddress}>\r\n` +
            `To: ${fromAddress}\r\n` +
            `Subject: Re: ${subject}\r\n` +
            `In-Reply-To: <${originalMessage.data.threadId}>\r\n` +
            `References: <${originalMessage.data.threadId}>\r\n\r\n` +
            `${replyText}`;

        // Send the reply using the Gmail API
        await gmail.users.messages.send({
            userId: "me",
            requestBody: {
                threadId: threadId,
                raw: Buffer.from(replyMessage).toString("base64"),
            },
            auth: oAuth2Client,
        });

        // creating label for replied mail
        const labelName = "Node_Replied";
        const labelResponse = await gmail.users.labels.create({
            userId: "me",
            requestBody: {
                name: labelName,
                messageListVisibility: "show",
                labelListVisibility: "labelShow",
            },
        });

        const labelId = labelResponse.data.id;

        await gmail.users.messages.modify({
            userId: "me",
            id: messageId,
            requestBody: {
                addLabelIds: [labelId as string],
            },
        });

        console.log("Reply sent successfully");
    } catch (error) {
        console.error("Error sending reply:", error);
    }
}
setInterval(checkNewMails, 5000);

/**Math.floor(Math.random() * (120000 - 45000 + 1)) + 45000 */

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
