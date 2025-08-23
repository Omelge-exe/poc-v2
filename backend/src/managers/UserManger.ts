import { Socket } from "socket.io";
import { RoomManager } from "./RoomManager";

export interface User {
    socket: Socket;
    name: string;
}

export class UserManager {
    private users: User[];
    private queue: string[];

    // NEW: track bans, partner links, online, and per-user room
    private bans: Map<string, Set<string>>;
    private partnerOf: Map<string, string>;
    private online: Set<string>;
    private roomOf: Map<string, string>;

    private roomManager: RoomManager;
    
    constructor() {
        this.users = [];
        this.queue = [];
        this.roomManager = new RoomManager();

        this.bans = new Map();
        this.partnerOf = new Map();
        this.online = new Set();
        this.roomOf = new Map();
    }

    addUser(name: string, socket: Socket) {
        this.users.push({ name, socket });
        this.online.add(socket.id);

        // join queue immediately
        if (!this.queue.includes(socket.id)) {
            this.queue.push(socket.id);
        }

        socket.emit("lobby");
        this.clearQueue(); // keep your existing call/flow

        this.initHandlers(socket);
    }

    removeUser(socketId: string) {
        const user = this.users.find(x => x.socket.id === socketId);

        // remove from list
        this.users = this.users.filter(x => x.socket.id !== socketId);

        // FIX: actually remove from queue (your code was keeping only the leaver)
        this.queue = this.queue.filter(x => x !== socketId);

        // clean presence
        this.online.delete(socketId);

        // if they were in a room/paired, handle like leave
        this.handleLeave(socketId, "explicit-remove");
    }

    // ---------- MATCHING / QUEUE ----------

    // Keep your function name + logs, but implement safe matching with bans and presence
    clearQueue() {
        console.log("inside clear queues")
        console.log(this.queue.length);
        if (this.queue.length < 2) {
            return;
        }

        // find first valid pair not banned from each other and both online
        let id1: string | undefined;
        let id2: string | undefined;

        outer:
        for (let i = 0; i < this.queue.length; i++) {
            const a = this.queue[i];
            if (!this.online.has(a)) continue;

            const bansA = this.bans.get(a) || new Set<string>();

            for (let j = i + 1; j < this.queue.length; j++) {
                const b = this.queue[j];
                if (!this.online.has(b)) continue;

                const bansB = this.bans.get(b) || new Set<string>();
                if (bansA.has(b) || bansB.has(a)) continue; // never rematch

                id1 = a; id2 = b;
                break outer;
            }
        }

        if (!id1 || !id2) {
            return; // no valid pair right now
        }

        console.log("id is " + id1 + " " + id2);

        const user1 = this.users.find(x => x.socket.id === id1);
        const user2 = this.users.find(x => x.socket.id === id2);
        if (!user1 || !user2) return;

        console.log("creating roonm");

        // remove both from queue for pairing
        this.queue = this.queue.filter(x => x !== id1 && x !== id2);

        // create room and remember links
        const roomId = this.roomManager.createRoom(user1, user2);

        this.partnerOf.set(id1, id2);
        this.partnerOf.set(id2, id1);
        this.roomOf.set(id1, roomId);
        this.roomOf.set(id2, roomId);

        // keep matching others if possible
        this.clearQueue();
    }

    // Try to get this user matched immediately (used after requeue)
    private tryMatchFor(userId: string) {
        if (!this.online.has(userId)) return;
        if (!this.queue.includes(userId)) this.queue.push(userId);
        this.clearQueue();
    }

    // ---------- LEAVE / DISCONNECT / NEXT ----------

    // Unified leave handler. If a user leaves, partner is requeued + notified.
    private handleLeave(leaverId: string, reason: string = "leave") {
        const partnerId = this.partnerOf.get(leaverId);

        // always remove leaver from queue
        this.queue = this.queue.filter(x => x !== leaverId);

        // clean leaver links
        const leaverRoomId = this.roomOf.get(leaverId);
        if (leaverRoomId) {
            this.roomManager.teardownUser(leaverRoomId, leaverId);
            this.roomOf.delete(leaverId);
        }
        this.partnerOf.delete(leaverId);

        if (partnerId) {
            // ban each other to prevent rematch
            const bansA = this.bans.get(leaverId) || new Set<string>();
            const bansB = this.bans.get(partnerId) || new Set<string>();
            bansA.add(partnerId);
            bansB.add(leaverId);
            this.bans.set(leaverId, bansA);
            this.bans.set(partnerId, bansB);

            // clean partner side of the room/pair
            const partnerRoomId = this.roomOf.get(partnerId);
            if (partnerRoomId) {
                this.roomManager.teardownUser(partnerRoomId, partnerId);
                this.roomOf.delete(partnerId);
            }
            this.partnerOf.delete(partnerId);

            // keep partner waiting: requeue + notify + try match now
            const partnerUser = this.users.find(u => u.socket.id === partnerId);
            if (partnerUser && this.online.has(partnerId)) {
                partnerUser.socket.emit("partner:left", { reason });
                if (!this.queue.includes(partnerId)) this.queue.push(partnerId);
                this.tryMatchFor(partnerId);
            }
        }
    }

    private onNext(userId: string) {
        const partnerId = this.partnerOf.get(userId);
        if (!partnerId) {
            // user is not currently paired; just ensure they are queued
            if (!this.queue.includes(userId)) this.queue.push(userId);
            this.tryMatchFor(userId);
            return;
        }

        // Ban both
        const bansU = this.bans.get(userId) || new Set<string>();
        const bansP = this.bans.get(partnerId) || new Set<string>();
        bansU.add(partnerId);
        bansP.add(userId);
        this.bans.set(userId, bansU);
        this.bans.set(partnerId, bansP);

        // Teardown room links
        const roomIdU = this.roomOf.get(userId);
        if (roomIdU) this.roomManager.teardownRoom(roomIdU);

        this.partnerOf.delete(userId);
        this.partnerOf.delete(partnerId);
        this.roomOf.delete(userId);
        this.roomOf.delete(partnerId);

        // Requeue caller immediately; notify partner their match ended
        if (!this.queue.includes(userId)) this.queue.push(userId);
        const partnerUser = this.users.find(u => u.socket.id === partnerId);
        if (partnerUser && this.online.has(partnerId)) {
            partnerUser.socket.emit("partner:left", { reason: "next" });
            // Optional: also requeue partner automatically
            if (!this.queue.includes(partnerId)) this.queue.push(partnerId);
        }

        // Try to rematch the caller right away
        this.tryMatchFor(userId);
    }

    // ---------- SOCKET HANDLERS ----------

    initHandlers(socket: Socket) {
        // WebRTC signaling passthrough
        socket.on("offer", ({sdp, roomId}: {sdp: string, roomId: string}) => {
            this.roomManager.onOffer(roomId, sdp, socket.id);
        });

        socket.on("answer",({sdp, roomId}: {sdp: string, roomId: string}) => {
            this.roomManager.onAnswer(roomId, sdp, socket.id);
        });

        socket.on("add-ice-candidate", ({candidate, roomId, type}) => {
            this.roomManager.onIceCandidates(roomId, socket.id, candidate, type);
        });

        // NEW: user actions
        socket.on("queue:next", () => {
            this.onNext(socket.id);
        });

        socket.on("queue:leave", () => {
            // user wants to leave matching; remove from queue and clean links
            this.queue = this.queue.filter(x => x !== socket.id);
            this.handleLeave(socket.id, "leave-button");
        });

        socket.on("disconnect", () => {
            // treat as a leave, but do not remove the partner; requeue them
            this.handleLeave(socket.id, "disconnect");
            this.online.delete(socket.id);
        });

        // Media state synchronization
        socket.on("media-state", ({ roomId, micOn, camOn }: { roomId: string; micOn: boolean; camOn: boolean }) => {
            console.log(`Media state from ${socket.id}:`, { roomId, micOn, camOn });
            const partnerId = this.partnerOf.get(socket.id);
            if (partnerId) {
                const partnerUser = this.users.find(u => u.socket.id === partnerId);
                if (partnerUser && this.online.has(partnerId)) {
                    console.log(`Forwarding media state to partner ${partnerId}:`, { micOn, camOn });
                    partnerUser.socket.emit("remote:media-state", { micOn, camOn });
                } else {
                    console.log(`Partner ${partnerId} not found or offline`);
                }
            } else {
                console.log(`No partner found for ${socket.id}`);
            }
        });

        // Screen state synchronization
        socket.on("screen:state", ({ roomId, on }: { roomId: string; on: boolean }) => {
            console.log(`Screen state from ${socket.id}:`, { roomId, on });
            const partnerId = this.partnerOf.get(socket.id);
            if (partnerId) {
                const partnerUser = this.users.find(u => u.socket.id === partnerId);
                if (partnerUser && this.online.has(partnerId)) {
                    console.log(`Forwarding screen state to partner ${partnerId}:`, { on });
                    partnerUser.socket.emit("remote:screen-state", { on });
                } else {
                    console.log(`Partner ${partnerId} not found or offline for screen state`);
                }
            } else {
                console.log(`No partner found for screen state from ${socket.id}`);
            }
        });

        // Chat handlers
        socket.on("chat:join", ({ roomId, name }: { roomId: string; name: string }) => {
            console.log(`Chat join request from ${socket.id} for room ${roomId} with name ${name}`);
            // Just acknowledge - in a peer-to-peer room, both users are automatically in chat
            socket.emit("chat:system", { text: "Chat connected", ts: Date.now() });
            
            // Notify partner that user joined chat (optional)
            const partnerId = this.partnerOf.get(socket.id);
            if (partnerId) {
                const partnerUser = this.users.find(u => u.socket.id === partnerId);
                if (partnerUser && this.online.has(partnerId)) {
                    console.log(`Notifying partner ${partnerId} that ${name} joined chat`);
                }
            }
        });

        socket.on("chat:message", ({ roomId, text, from, clientId, ts }: { 
            roomId: string; 
            text: string; 
            from: string; 
            clientId: string; 
            ts: number 
        }) => {
            console.log(`Chat message from ${socket.id} (${from}):`, { roomId, text: text.substring(0, 50) + '...', clientId });
            const partnerId = this.partnerOf.get(socket.id);
            if (partnerId && text && text.length <= 1000) {
                const partnerUser = this.users.find(u => u.socket.id === partnerId);
                if (partnerUser && this.online.has(partnerId)) {
                    console.log(`Forwarding message to partner ${partnerId}`);
                    partnerUser.socket.emit("chat:message", { text, from, clientId, ts });
                } else {
                    console.log(`Partner ${partnerId} not found or offline for message forwarding`);
                }
            } else {
                console.log(`Message not forwarded - no partner or invalid text length`, { 
                    hasPartner: !!partnerId, 
                    textLength: text?.length 
                });
            }
        });

        socket.on("chat:typing", ({ roomId, from, typing }: { roomId: string; from: string; typing: boolean }) => {
            console.log(`Typing status from ${socket.id} (${from}):`, { roomId, typing });
            const partnerId = this.partnerOf.get(socket.id);
            if (partnerId) {
                const partnerUser = this.users.find(u => u.socket.id === partnerId);
                if (partnerUser && this.online.has(partnerId)) {
                    console.log(`Forwarding typing status to partner ${partnerId}:`, { from, typing });
                    partnerUser.socket.emit("chat:typing", { from, typing });
                } else {
                    console.log(`Partner ${partnerId} not found or offline for typing status`);
                }
            } else {
                console.log(`No partner found for typing status from ${socket.id}`);
            }
        });
    }
}
