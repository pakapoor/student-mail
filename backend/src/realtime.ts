import type { Response } from "express";

interface Client {
    res: Response;
    centralEmail: string;
}

const clients = new Set<Client>();

export function addClient(res: Response, centralEmail: string) {
    clients.add({ res, centralEmail });
}

export function removeClient(res: Response) {
    for (const client of clients) {
        if (client.res === res) {
            clients.delete(client);
            break;
        }
    }
}

export function broadcast(event: string, data: unknown, centralEmail: string) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of clients) {
        if (client.centralEmail === centralEmail) {
            client.res.write(payload);
        }
    }
}
