import { OAuth2Scopes, PermissionFlagsBits } from 'discord.js';

const permissions = [
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.ManageRoles, // For role checking in amikool command
].reduce((acc, p) => acc | p, 0n);

const scopes = [
  OAuth2Scopes.Bot,
  OAuth2Scopes.ApplicationsCommands,
];

const clientId = process.env.CLIENT_ID;
if (!clientId) {
  console.error('CLIENT_ID is not set in .env file');
  process.exit(1);
}

const url = new URL('https://discord.com/api/oauth2/authorize');
url.searchParams.set('client_id', clientId);
url.searchParams.set('permissions', permissions.toString());
url.searchParams.set('scope', scopes.join(' '));

console.log('OAuth2 URL with correct permissions:');
console.log(url.toString());
