import { MessageFlags } from 'discord.js';
import { successEmbed } from '../../utils/embeds.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { TitanBotError, ErrorTypes } from '../../utils/errorHandler.js';
import { getGuildMusicData, clearUpdateInterval } from './playerStore.js';
import { canControlMusic, requireVoiceChannel, VOICE_CHANNEL_DENIAL } from './permissions.js';
import {
    buildNowPlayingEmbed,
    buildQueueEmbed,
    buildQueuePaginationRow,
    getQueuePageSize,
} from './musicEmbeds.js';
import { refreshPlayerMessage } from './playerHandler.js';


export function getPlayer(client, guildId) {
    return client.riffy?.players?.get(guildId) || null;
}


export function assertRiffyAvailable(client) {
    if (!client.riffy) {
        throw new TitanBotError(
            'Lavalink not configured',
            ErrorTypes.CONFIGURATION,
            'Music is unavailable — Lavalink is not configured.',
        );
    }
}


export function assertInVoice(member) {
    if (!requireVoiceChannel(member)) {
        throw new TitanBotError(
            'Not in voice channel',
            ErrorTypes.USER_INPUT,
            'You need to be in a voice channel.',
        );
    }
}


export function assertCanControl(member, player) {
    if (!canControlMusic(member, player)) {
        throw new TitanBotError(
            'Wrong voice channel',
            ErrorTypes.PERMISSION,
            VOICE_CHANNEL_DENIAL,
        );
    }
}


export async function ensurePlayer(client, interaction) {
    assertRiffyAvailable(client);
    assertInVoice(interaction.member);

    const guildId = interaction.guild.id;
    const guildData = getGuildMusicData(guildId);

    let player = getPlayer(client, guildId);

    if (!player) {
        player = client.riffy.createConnection({
            guildId,
            voiceChannel: interaction.member.voice.channel.id,
            textChannel: interaction.channel.id,
            deaf: true,
        });

        guildData.playerChannelId = interaction.channel.id;
    }

    player.setVolume(guildData.volume);

    return {
        player,
        guildData,
    };
}


function isDuplicateTrack(player, track) {
    const uri = track?.info?.uri;

    if (!uri) {
        return false;
    }

    if (player.current?.info?.uri === uri) {
        return true;
    }

    return player.queue.some(
        existing => existing.info?.uri === uri
    );
}


export async function joinVoiceChannel(client, interaction) {
    assertRiffyAvailable(client);
    assertInVoice(interaction.member);

    const guildId = interaction.guild.id;
    const guildData = getGuildMusicData(guildId);
    const channel = interaction.member.voice.channel;

    let player = getPlayer(client, guildId);


    if (player && player.voiceChannel !== channel.id) {
        try {
            player.destroy();
        } catch {}

        player = null;
    }


    if (!player) {
        player = client.riffy.createConnection({
            guildId,
            voiceChannel: channel.id,
            textChannel: interaction.channel.id,
            deaf: true,
        });

        guildData.playerChannelId = interaction.channel.id;
    }


    player.setVolume(guildData.volume);


    return successEmbed(
        'Joined Voice Channel',
        `Connected to **${channel.name}**.`,
    );
}



export async function playQuery(client, interaction, query) {

    const {
        player,
    } = await ensurePlayer(
        client,
        interaction
    );


    const result = await client.riffy.resolve({
        query,
        requester: interaction.user,
    });


    const {
        loadType,
        tracks,
        playlistInfo,
    } = result;



    if (
        loadType === 'playlist' ||
        loadType === 'PLAYLIST_LOADED'
    ) {

        let added = 0;
        let skipped = 0;


        for (const track of tracks) {

            track.info.requester = interaction.user;


            if (isDuplicateTrack(player, track)) {
                skipped++;
                continue;
            }


            player.queue.add(track);
            added++;
        }



        if (
            !player.playing &&
            !player.paused &&
            !player.current
        ) {
            player.play();
        }



        return {
            embed: successEmbed(
                'Playlist Added',
                `**${playlistInfo?.name || 'Playlist'}**\nAdded ${added}/${tracks.length} tracks.${skipped ? ` Skipped ${skipped} duplicate(s).` : ''}`,
            ),
        };
    }



    if (
        loadType === 'search' ||
        loadType === 'track' ||
        loadType === 'SEARCH_RESULT' ||
        loadType === 'TRACK_LOADED'
    ) {


        const track = tracks?.[0];


        if (!track) {
            throw new TitanBotError(
                'No results',
                ErrorTypes.USER_INPUT,
                'No song found.',
            );
        }



        if (isDuplicateTrack(player, track)) {
            throw new TitanBotError(
                'Duplicate track',
                ErrorTypes.USER_INPUT,
                `**${track.info.title}** is already playing or queued.`,
            );
        }



        track.info.requester = interaction.user;


        player.queue.add(track);



        if (
            !player.playing &&
            !player.paused &&
            !player.current
        ) {
            player.play();
        }



        return {
            embed: successEmbed(
                'Track Added',
                `**${track.info.title}** by **${track.info.author}**`,
            ),
        };
    }



    throw new TitanBotError(
        'No results',
        ErrorTypes.USER_INPUT,
        `Lavalink returned: ${loadType}`,
    );
}
export async function skipTrack(client, interaction) {
    const player = getPlayer(client, interaction.guild.id);

    if (!player?.current) {
        throw new TitanBotError(
            'No player',
            ErrorTypes.USER_INPUT,
            'Nothing is playing right now.',
        );
    }

    assertCanControl(interaction.member, player);

    const title = player.current.info?.title || 'Unknown';

    player.stop();

    return successEmbed(
        'Skipped',
        `Skipped **${title}**.`,
    );
}



export async function stopPlayback(client, interaction) {

    const player = getPlayer(
        client,
        interaction.guild.id,
    );


    if (!player) {
        throw new TitanBotError(
            'No player',
            ErrorTypes.USER_INPUT,
            'No active music player.',
        );
    }


    assertCanControl(
        interaction.member,
        player,
    );


    const guildData = getGuildMusicData(
        interaction.guild.id,
    );


    const queueLength = player.queue?.length || 0;



    if (
        queueLength >= 5 &&
        guildData.stopConfirmPending !== interaction.user.id
    ) {

        guildData.stopConfirmPending =
            interaction.user.id;


        setTimeout(() => {

            if (
                guildData.stopConfirmPending === interaction.user.id
            ) {
                guildData.stopConfirmPending = null;
            }

        }, 15000);



        return successEmbed(
            'Confirm Stop',
            `There are **${queueLength}** tracks in queue. Run **/music stop** again within 15 seconds.`,
        );
    }



    guildData.stopConfirmPending = null;


    await destroyPlayerSession(
        client,
        interaction.guild.id,
        player,
        guildData,
    );


    return successEmbed(
        'Stopped',
        'Playback stopped and queue cleared.',
    );
}





export async function applyPause(client, guildId) {

    const player = getPlayer(
        client,
        guildId,
    );


    if (
        !player?.current ||
        player.paused
    ) {
        return false;
    }


    player.pause(true);


    getGuildMusicData(guildId).wasPaused = true;


    await refreshPlayerMessage(
        client,
        guildId,
    );


    return true;
}





export async function applyResume(client, guildId) {

    const player = getPlayer(
        client,
        guildId,
    );


    if (
        !player?.current ||
        !player.paused
    ) {
        return false;
    }


    player.pause(false);


    getGuildMusicData(guildId).wasPaused = false;


    await refreshPlayerMessage(
        client,
        guildId,
    );


    return true;
}





export async function pausePlayback(client, interaction) {

    const player = getPlayer(
        client,
        interaction.guild.id,
    );


    if (!player?.current) {

        throw new TitanBotError(
            'No player',
            ErrorTypes.USER_INPUT,
            'Nothing is playing right now.',
        );

    }



    assertCanControl(
        interaction.member,
        player,
    );



    if (player.paused) {

        throw new TitanBotError(
            'Already paused',
            ErrorTypes.USER_INPUT,
            'Playback is already paused.',
        );

    }



    await applyPause(
        client,
        interaction.guild.id,
    );



    return successEmbed(
        'Paused',
        'Playback paused.',
    );
}





export async function resumePlayback(client, interaction) {

    const player = getPlayer(
        client,
        interaction.guild.id,
    );



    if (!player?.current) {

        throw new TitanBotError(
            'No player',
            ErrorTypes.USER_INPUT,
            'Nothing is playing right now.',
        );

    }



    assertCanControl(
        interaction.member,
        player,
    );



    if (!player.paused) {

        throw new TitanBotError(
            'Not paused',
            ErrorTypes.USER_INPUT,
            'Playback is not paused.',
        );

    }



    await applyResume(
        client,
        interaction.guild.id,
    );



    return successEmbed(
        'Resumed',
        'Playback resumed.',
    );
}





export async function shuffleQueue(client, interaction) {

    const player = getPlayer(
        client,
        interaction.guild.id,
    );



    if (!player?.queue?.length) {

        throw new TitanBotError(
            'Empty queue',
            ErrorTypes.USER_INPUT,
            'The queue is empty.',
        );

    }



    assertCanControl(
        interaction.member,
        player,
    );



    player.queue.shuffle();



    getGuildMusicData(
        interaction.guild.id,
    ).shuffle = true;



    await refreshPlayerMessage(
        client,
        interaction.guild.id,
    );



    return successEmbed(
        'Shuffled',
        'Queue shuffled.',
    );
}





export async function setLoopMode(client, interaction, mode) {

    const player = getPlayer(
        client,
        interaction.guild.id,
    );



    if (!player) {

        throw new TitanBotError(
            'No player',
            ErrorTypes.USER_INPUT,
            'No active music player.',
        );

    }



    assertCanControl(
        interaction.member,
        player,
    );



    const guildData =
        getGuildMusicData(
            interaction.guild.id,
        );



    guildData.loop = mode;



    player.setLoop(mode);



    const labels = {
        none: 'Off',
        track: 'Track',
        queue: 'Queue',
    };



    await refreshPlayerMessage(
        client,
        interaction.guild.id,
    );



    return successEmbed(
        'Loop Updated',
        `Loop mode: **${labels[mode] || mode}**`,
    );
}





export async function toggleLoop(client, interaction) {

    const guildData =
        getGuildMusicData(
            interaction.guild.id,
        );



    const next =
        guildData.loop === 'none'
            ? 'track'
            : guildData.loop === 'track'
                ? 'queue'
                : 'none';



    return setLoopMode(
        client,
        interaction,
        next,
    );
}





export async function setVolume(client, interaction, volume) {

    const player = getPlayer(
        client,
        interaction.guild.id,
    );



    if (!player) {

        throw new TitanBotError(
            'No player',
            ErrorTypes.USER_INPUT,
            'No active music player.',
        );

    }



    assertCanControl(
        interaction.member,
        player,
    );



    const guildData =
        getGuildMusicData(
            interaction.guild.id,
        );



    guildData.volume =
        Math.max(
            0,
            Math.min(
                100,
                volume,
            ),
        );



    player.setVolume(
        guildData.volume,
    );



    await refreshPlayerMessage(
        client,
        interaction.guild.id,
    );



    return successEmbed(
        'Volume Updated',
        `Volume: **${guildData.volume}%**`,
    );
}





export async function adjustVolume(client, interaction, delta) {

    const guildData =
        getGuildMusicData(
            interaction.guild.id,
        );


    return setVolume(
        client,
        interaction,
        guildData.volume + delta,
    );
}
export function buildNowPlayingReply(client, guildId) {
    const player = getPlayer(client, guildId);

    if (!player?.current) {
        throw new TitanBotError(
            'No player',
            ErrorTypes.USER_INPUT,
            'Nothing is playing right now.',
        );
    }

    const guildData = getGuildMusicData(guildId);

    return {
        embeds: [
            buildNowPlayingEmbed(
                player.current,
                player,
                guildData,
            ),
        ],
    };
}


export function buildQueueReply(client, guildId, page = 0) {
    const player = getPlayer(client, guildId);

    if (!player) {
        throw new TitanBotError(
            'No player',
            ErrorTypes.USER_INPUT,
            'No active music player.',
        );
    }

    const totalPages = Math.max(
        1,
        Math.ceil(
            (player.queue?.length || 0) /
            getQueuePageSize(),
        ),
    );

    const safePage = Math.min(
        Math.max(page, 0),
        totalPages - 1,
    );

    return {
        embeds: [
            buildQueueEmbed(
                player.queue,
                player.current,
                safePage,
            ),
        ],
        components:
            totalPages > 1
                ? [
                    buildQueuePaginationRow(
                        safePage,
                        totalPages,
                    ),
                ]
                : [],
        page: safePage,
        totalPages,
    };
}


export async function destroyPlayerSession(
    client,
    guildId,
    player,
    guildData,
    { forceDisconnect = false } = {},
) {
    clearUpdateInterval(guildData);

    if (guildData.idleTimeout) {
        clearTimeout(guildData.idleTimeout);
        guildData.idleTimeout = null;
    }

    guildData.previousTracks = [];
    guildData.stopConfirmPending = null;

    if (
        guildData.playerMessageId &&
        guildData.playerChannelId
    ) {
        try {
            const channel = client.channels.cache.get(
                guildData.playerChannelId,
            );

            if (channel) {
                const msg = await channel.messages.fetch(
                    guildData.playerMessageId,
                );

                await msg.delete();
            }
        } catch {
            // message already removed
        }
    }

    guildData.playerMessageId = null;
    guildData.playerChannelId = null;


    if (player) {
        try {
            player.queue.clear();
        } catch {}

        try {
            player.stop();
        } catch {}

        if (
            forceDisconnect ||
            !guildData.twentyFourSeven
        ) {
            try {
                player.destroy();
            } catch {}
        }
    }
}


export async function leaveVoiceChannel(client, interaction) {
    assertRiffyAvailable(client);

    const guildId = interaction.guild.id;

    const player = getPlayer(
        client,
        guildId,
    );

    if (!player) {
        throw new TitanBotError(
            'No player',
            ErrorTypes.USER_INPUT,
            'I am not connected to a voice channel.',
        );
    }

    assertCanControl(
        interaction.member,
        player,
    );


    const channel =
        interaction.guild.channels.cache.get(
            player.voiceChannel,
        );

    const channelName =
        channel?.name || 'voice channel';


    const guildData =
        getGuildMusicData(guildId);


    await destroyPlayerSession(
        client,
        guildId,
        player,
        guildData,
        {
            forceDisconnect: true,
        },
    );


    return successEmbed(
        'Left Voice Channel',
        `Disconnected from **${channelName}**.`,
    );
}


export async function replyMusicSuccess(
    interaction,
    embed,
) {
    if (
        interaction.deferred ||
        interaction.replied
    ) {
        await InteractionHelper.safeEditReply(
            interaction,
            {
                embeds: [embed],
            },
        );

        return;
    }


    await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
    });
}
