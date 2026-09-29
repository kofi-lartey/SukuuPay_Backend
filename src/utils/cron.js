import cron from "cron";
import http from "http";
import https from "https";

const job = new cron.CronJob("*/14 * * * *", function() {
    const url = process.env.API_URL + "/api/health";
    const client = url.startsWith("https") ? https : http;
    client
        .get(url, (res) => {
            if (res.statusCode == 200) console.log("Health check passed")
            else console.log("Health check failed", res.statusCode)
        })
        .on("error", (e) => console.error("Error while sending health check", e))
});

export default job
