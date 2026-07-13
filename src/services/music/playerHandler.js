// Player event handlers for Riffy. Adapted from Musicify playerHandler (Apache-2.0).

import { logger } from '../../utils/logger.js';
import { getGuildMusicData, clearUpdateInterval } from './playerStore.js';
import {
    buildNowPlayingEmbed,
    buildPlayerButtonRows,
} from './musicEmbeds.js';

const UPDATE_INTERVAL_MS = 10 * 1000; // Update every 10 seconds for smoother panel updates
const IDLE_DISCONNECT_MS = 5 * 60 * 1000; // 5 minutes idle timeout instead of 30 seconds

async function editOrSendPlayerMessage(client, guildData, channelId, embed, components) {
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
        return;
    }

    const payload = { embeds: [embed], components };

    if (guildData.playerMessageId) {
        try {
            const msg = await channel.messages.fetch(guildData.playerMessageId);
            await msg.edit(payload).catch(error => {
                // If message edit fails, try sending a new one
                logger.debug('Failed to edit player message, sending new one:', error.message);
                guildData.playerMessageId = null;
            });
            return;
        } catch (error) {
            logger.debug('Failed to fetch player message:', error.message);
            guildData.playerMessageId = null;
            guildData.playerChannelId = null;
            clearUpdateInterval(guildData);
        }
    }

    try {
        const newMsg = await channel.send(payload);
        guildData.playerMessageId = newMsg.id;
        guildData.playerChannelId = channel.id;
    } catch (error) {
        logger.error('Failed to send music player message:', error);
    }
}

export async function refreshPlayerMessage(client, guildId) {
    try {
        const player = client.riffy?.players?.get(guildId);
        if (!player?.current) {
            return;
        }

        const guildData = getGuildMusicData(guildId);
        const embed = buildNowPlayingEmbed(player.current, player, guildData);
        const components = buildPlayerButtonRows(player, guildData);
        const channelId = guildData.playerChannelId;
        await editOrSendPlayerMessage(client, guildData, channelId, embed, components);
    } catch (error) {
        logger.error('Failed to refresh music player message:', error);
    }
}

function startUpdateInterval(client, guildId) {
    const guildData = getGuildMusicData(guildId);
    clearUpdateInterval(guildData);
    guildData.updateInterval = setInterval(() => {
        refreshPlayerMessage(client, guildId).catch(error => {
            logger.debug('Error in update interval:', error.message);
        });
    }, UPDATE_INTERVAL_MS);
}

export function setupPlayerHandler(client) {
    if (!client.riffy) {
        logger.warn('Riffy not initialized; music player handlers not attached.');
        return;
    }

    client.riffy.on('nodeConnect', (node) => {
        logger.info(`Lavalink node "${node.name}" connected.`);
    });

    client.riffy.on('nodeError', (node, error) => {
        logger.error(`Lavalink node "${node.name}" error:`, error?.message || error);
    });

    client.riffy.on('nodeDisconnect', (node) => {
        logger.warn(`Lavalink node "${node.name}" disconnected.`);
    });

    client.riffy.on('nodeReconnect', (node) => {
        logger.info(`Lavalink node "${node.name}" reconnected.`);
    });

    client.riffy.on('trackStart', async (player, track) => {
        try {
            const guildData = getGuildMusicData(player.guildId);

            if (player.previous) {
                guildData.previousTracks.push(player.previous);
                if (guildData.previousTracks.length > 20) {
                    guildData.previousTracks.shift();
                }
            }

            if (guildData.idleTimeout) {
                clearTimeout(guildData.idleTimeout);
                guildData.idleTimeout = null;
            }

            const embed = buildNowPlayingEmbed(track, player, guildData);
            const components = buildPlayerButtonRows(player, guildData);
            const channelId = guildData.playerChannelId;
            await editOrSendPlayerMessage(client, guildData, channelId, embed, components);
            startUpdateInterval(client, player.guildId);
        } catch (error) {
            logger.error('Music trackStart error:', error);
        }
    });

    client.riffy.on('queueEnd', async (player) => {
        try {
            const guildData = getGuildMusicData(player.guildId);
            clearUpdateInterval(guildData);

            if (guildData.autoplay) {
                logger.info(`Autoplay enabled for guild ${player.guildId}, triggering autoplay...`);
                player.autoplay(player);
                return;
            }

            logger.info(`Queue ended for guild ${player.guildId}. Setting ${IDLE_DISCONNECT_MS / 1000}s timeout...`);

            if (!guildData.twentyFourSeven) {
                if (guildData.idleTimeout) {
                    clearTimeout(guildData.idleTimeout);
                }
                
                guildData.idleTimeout = setTimeout(() => {
                    try {
                        const currentPlayer = client.riffy.players.get(player.guildId);
                        if (currentPlayer && !currentPlayer.playing && !currentPlayer.paused && !currentPlayer.current) {
                            logger.info(`Destroying idle player for guild ${player.guildId} after ${IDLE_DISCONNECT_MS / 1000}s timeout`);
                            currentPlayer.destroy();
                        }
                    } catch (error) {
                        logger.debug('Error destroying idle player:', error.message);
                    }
                    guildData.idleTimeout = null;
                }, IDLE_DISCONNECT_MS);
            } else {
                logger.info(`24/7 mode enabled for guild ${player.guildId}, keeping player active`);
            }
        } catch (error) {
            logger.error('Music queueEnd error:', error);
        }
    });

    client.riffy.on('playerDisconnect', async (player) => {
        const guildData = getGuildMusicData(player.guildId);
        clearUpdateInterval(guildData);

        if (guildData.playerMessageId && guildData.playerChannelId) {
            try {
                const channel = client.channels.cache.get(guildData.playerChannelId);
                if (channel) {
                    const msg = await channel.messages.fetch(guildData.playerMessageId);
                    await msg.delete();
                }
            } catch {
                // already deleted
            }
        }

        guildData.playerMessageId = null;
        guildData.playerChannelId = null;
        guildData.previousTracks = [];
        if (guildData.idleTimeout) {
            clearTimeout(guildData.idleTimeout);
            guildData.idleTimeout = null;
        }
        
        logger.info(`Player disconnected from guild ${player.guildId}`);
    });

    client.riffy.on('trackError', async (player, track, payload) => {
        const trackTitle = track?.info?.title || 'unknown track';
        const guildId = player?.guildId || 'unknown guild';
        const errorMessage = payload?.error || payload?.message || JSON.stringify(payload);
        
        logger.error(`Track error in ${guildId} for "${trackTitle}":`, errorMessage);
        
        const guildData = getGuildMusicData(guildId);
        if (guildData?.playerChannelId) {
            const channel = client.channels.cache.get(guildData.playerChannelId);
            if (channel) {
                channel.send(`❌ Failed to play **${trackTitle}**. Skipping to next track...`).catch(() => null);
            }
        }
    });

    client.riffy.on('trackStuck', async (player, track, payload) => {
        const trackTitle = track?.info?.title || 'unknown track';
        logger.warn(`Track stuck in ${player.guildId} for "${trackTitle}" (${payload?.thresholdMs}ms)`);
        
        const guildData = getGuildMusicData(player.guildId);
        if (guildData?.playerChannelId) {
            const channel = client.channels.cache.get(guildData.playerChannelId);
            if (channel) {
                channel.send(`⚠️ Track stuck: **${trackTitle}**. Skipping...`).catch(() => null);
            }
        }
    });
}

export async function shutdownMusic(client) {
    if (!client.riffy?.players) {
        return;
    }

    for (const player of client.riffy.players.values()) {
        try {
            player.destroy();
        } catch (error) {
            logger.debug('Error destroying music player during shutdown:', error.message);
        }
    }
}
