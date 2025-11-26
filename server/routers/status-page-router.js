let express = require("express");
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const StatusPage = require("../model/status_page");
const { allowDevAllOrigin, sendHttpError } = require("../util-server");
const { R } = require("redbean-node");
const { badgeConstants, DOWN, UP, MAINTENANCE } = require("../../src/util");
const { makeBadge } = require("badge-maker");
const { UptimeCalculator } = require("../uptime-calculator");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");

dayjs.extend(utc);

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();

router.get("/status/:slug", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status/:slug/rss", cache("5 minutes"), async (request, response) => {
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    await StatusPage.handleStatusPageRSSResponse(response, slug);
});

router.get("/status", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

router.get("/status-page", cache("5 minutes"), async (request, response) => {
    let slug = "default";
    await StatusPage.handleStatusPageResponse(response, server.indexHTML, slug);
});

// Status page config, incident, monitor list
router.get("/api/status-page/:slug", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [
            slug
        ]);

        if (!statusPage) {
            sendHttpError(response, "Status Page Not Found");
            return null;
        }

        let statusPageData = await StatusPage.getStatusPageData(statusPage);

        // Response
        response.json(statusPageData);

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status Page Polling Data
// Can fetch only if published
router.get("/api/status-page/heartbeat/:slug", cache("1 minutes"), async (request, response) => {
    allowDevAllOrigin(response);

    try {
        let heartbeatList = {};
        let uptimeList = {};

        let slug = request.params.slug;
        slug = slug.toLowerCase();
        const statusPage = await R.findOne("status_page", " slug = ? ", [
            slug
        ]);

        if (!statusPage) {
            sendHttpError(response, "Status Page Not Found");
            return;
        }

        const statusPageID = statusPage.id;
        const heartbeatBarDays = Math.max(0, Math.min(365, parseInt(request.query.days ?? statusPage.heartbeat_bar_days ?? 0) || 0));
        const maxBeat = Math.max(1, Math.min(parseInt(request.query.maxBeat) || 120, 1000));

        let monitorIDList = await R.getCol(`
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `, [
            statusPageID
        ]);

        for (let monitorID of monitorIDList) {
            if (heartbeatBarDays > 0) {
                heartbeatList[monitorID] = await buildAggregatedHeartbeatList(monitorID, heartbeatBarDays, maxBeat);
            } else {
                let list = await R.getAll(`
                        SELECT * FROM heartbeat
                        WHERE monitor_id = ?
                        ORDER BY time DESC
                        LIMIT 100
                `, [
                    monitorID,
                ]);

                list = R.convertToBeans("heartbeat", list);
                heartbeatList[monitorID] = list.reverse().map(row => row.toPublicJSON());
            }

            const uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);
            uptimeList[`${monitorID}_24`] = uptimeCalculator.get24Hour().uptime;
        }

        response.json({
            heartbeatList,
            uptimeList
        });

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

// Status page's manifest.json
router.get("/api/status-page/:slug/manifest.json", cache("1440 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();

    try {
        // Get Status Page
        let statusPage = await R.findOne("status_page", " slug = ? ", [
            slug
        ]);

        if (!statusPage) {
            sendHttpError(response, "Not Found");
            return;
        }

        // Response
        response.json({
            "name": statusPage.title,
            "start_url": "/status/" + statusPage.slug,
            "display": "standalone",
            "icons": [
                {
                    "src": statusPage.icon,
                    "sizes": "128x128",
                    "type": "image/png"
                }
            ]
        });

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

/**
 * Build aggregated heartbeat-like entries for the status page timeline using stat tables.
 * @param {number} monitorID Monitor id to load stats for
 * @param {number} days Number of days of history to include
 * @param {number} maxBeat Number of bars to return
 * @returns {Promise<object[]>} Aggregated heartbeat-style list
 */
async function buildAggregatedHeartbeatList(monitorID, days, maxBeat) {
    const bucketCount = Math.max(1, Math.min(maxBeat || 120, 1000));
    const totalSeconds = days * 86400;
    const bucketDurationSeconds = Math.max(60, Math.ceil(totalSeconds / bucketCount));

    let sourceTable = "stat_hourly";
    let tableResolution = 3600;

    if (days <= 1) {
        sourceTable = "stat_minutely";
        tableResolution = 60;
    } else if (days > 30) {
        sourceTable = "stat_daily";
        tableResolution = 86400;
    }

    // Avoid requesting buckets smaller than our source resolution
    const normalizedBucketDuration = Math.max(bucketDurationSeconds, tableResolution);
    const startTimestamp = Math.floor(dayjs().utc().subtract(days, "day").unix() / tableResolution) * tableResolution;

    const stats = await R.getAll(`
        SELECT timestamp, up, down, extras
        FROM ${sourceTable}
        WHERE monitor_id = ?
        AND timestamp >= ?
        ORDER BY timestamp ASC
    `, [
        monitorID,
        startTimestamp
    ]);

    const beats = [];
    let statIndex = 0;
    let bucketStart = startTimestamp;

    for (let i = 0; i < bucketCount; i++) {
        const bucketEnd = bucketStart + normalizedBucketDuration;
        let up = 0;
        let down = 0;
        let maintenance = 0;

        while (statIndex < stats.length && stats[statIndex].timestamp < bucketEnd) {
            const stat = stats[statIndex];
            up += Number(stat.up || 0);
            down += Number(stat.down || 0);

            if (stat.extras) {
                try {
                    const extras = JSON.parse(stat.extras);
                    maintenance += Number(extras?.maintenance || 0);
                } catch (parseError) {
                    // Ignore malformed extras JSON
                }
            }

            statIndex++;
        }

        let beat = 0;

        if (up || down || maintenance) {
            let status = UP;

            if (maintenance) {
                status = MAINTENANCE;
            }

            if (down) {
                status = DOWN;
            }

            beat = {
                status,
                time: dayjs.unix(bucketEnd).toISOString(),
                msg: "",
                ping: null,
            };
        }

        beats.push(beat);
        bucketStart = bucketEnd;
    }

    return beats;
}

// overall status-page status badge
router.get("/api/status-page/:slug/badge", cache("5 minutes"), async (request, response) => {
    allowDevAllOrigin(response);
    let slug = request.params.slug;
    slug = slug.toLowerCase();
    const statusPageID = await StatusPage.slugToID(slug);
    const {
        label,
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        partialColor = "#F6BE00",
        maintenanceColor = "#808080",
        style = badgeConstants.defaultStyle
    } = request.query;

    try {
        let monitorIDList = await R.getCol(`
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND public = 1
            AND \`group\`.status_page_id = ?
        `, [
            statusPageID
        ]);

        let hasUp = false;
        let hasDown = false;
        let hasMaintenance = false;

        for (let monitorID of monitorIDList) {
            // retrieve the latest heartbeat
            let beat = await R.getAll(`
                    SELECT * FROM heartbeat
                    WHERE monitor_id = ?
                    ORDER BY time DESC
                    LIMIT 1
            `, [
                monitorID,
            ]);

            // to be sure, when corresponding monitor not found
            if (beat.length === 0) {
                continue;
            }
            // handle status of beat
            if (beat[0].status === 3) {
                hasMaintenance = true;
            } else if (beat[0].status === 2) {
                // ignored
            } else if (beat[0].status === 1) {
                hasUp = true;
            } else {
                hasDown = true;
            }

        }

        const badgeValues = { style };

        if (!hasUp && !hasDown && !hasMaintenance) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;

        } else {
            if (hasMaintenance) {
                badgeValues.label = label ? label : "";
                badgeValues.color = maintenanceColor;
                badgeValues.message = "Maintenance";
            } else if (hasUp && !hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = upColor;
                badgeValues.message = "Up";
            } else if (hasUp && hasDown) {
                badgeValues.label = label ? label : "";
                badgeValues.color = partialColor;
                badgeValues.message = "Degraded";
            } else {
                badgeValues.label = label ? label : "";
                badgeValues.color = downColor;
                badgeValues.message = "Down";
            }

        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);

    } catch (error) {
        sendHttpError(response, error.message);
    }
});

module.exports = router;
