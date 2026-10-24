// One small EC2 box for a Node.js app: Caddy (automatic HTTPS) in front of a
// systemd service, a separate data volume that survives instance replacement,
// a static IP and an instance role. majapisoftwares/ci deploys releases to it
// over SSM with scripts/box-app/deploy.sh.
//
// Stack config (namespace box-app):
//   appName          required, e.g. majapi-cloud (names and tags)
//   domains          comma-separated; the first is the app URL
//   instanceType     default t4g.micro (ARM)
//   rootVolumeGb     default 8
//   dataVolumeGb     default 1, mounted at /data
//   policyStatements JSON array of extra IAM statements for the app's role
// Env: RUNTIME_ENV is stored as the app's runtime secret (dotenv text).
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config("box-app");
const appName = config.require("appName");
const domains = (config.get("domains") ?? "")
  .split(",")
  .map((domain) => domain.trim())
  .filter(Boolean);
const instanceType = config.get("instanceType") ?? "t4g.micro";
const rootVolumeGb = config.getNumber("rootVolumeGb") ?? 8;
const dataVolumeGb = config.getNumber("dataVolumeGb") ?? 1;
const policyStatements: unknown[] = JSON.parse(config.get("policyStatements") ?? "[]");
const boxName = `${appName}-box`;
const tags = { Name: boxName, project: appName, "managed-by": "majapisoftwares/ci" };

const vpc = aws.ec2.getVpcOutput({ default: true });
const subnet = aws.ec2
  .getSubnetsOutput({
    filters: [
      { name: "vpc-id", values: [vpc.id] },
      { name: "default-for-az", values: ["true"] },
    ],
  })
  .ids.apply((ids) => aws.ec2.getSubnet({ id: [...ids].sort()[0] }));

const securityGroup = new aws.ec2.SecurityGroup("web", {
  description: `${appName}: HTTP and HTTPS only; administration goes through SSM`,
  vpcId: vpc.id,
  ingress: [80, 443].map((port) => ({
    protocol: "tcp",
    fromPort: port,
    toPort: port,
    cidrBlocks: ["0.0.0.0/0"],
    ipv6CidrBlocks: ["::/0"],
  })),
  egress: [{ protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"], ipv6CidrBlocks: ["::/0"] }],
  tags,
});

const runtimeSecret = new aws.secretsmanager.Secret("runtime", {
  namePrefix: `${appName}/runtime-`,
  recoveryWindowInDays: 0,
  tags,
});
new aws.secretsmanager.SecretVersion("runtime", {
  secretId: runtimeSecret.id,
  secretString: process.env.RUNTIME_ENV || "# set RUNTIME_ENV\n",
});

const role = new aws.iam.Role("box", {
  namePrefix: `${appName}-box-`,
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
  }),
  tags,
});
new aws.iam.RolePolicyAttachment("ssm", {
  role: role.name,
  policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
});
new aws.iam.RolePolicy("app", {
  role: role.name,
  policy: runtimeSecret.arn.apply((secretArn) =>
    JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: "secretsmanager:GetSecretValue", Resource: secretArn },
        ...policyStatements,
      ],
    }),
  ),
});
const profile = new aws.iam.InstanceProfile("box", { namePrefix: `${appName}-box-`, role: role.name });

const dataVolume = new aws.ebs.Volume("data", {
  availabilityZone: subnet.availabilityZone,
  size: dataVolumeGb,
  type: "gp3",
  tags: { ...tags, Name: `${appName}-data` },
});

const ami = aws.ssm.getParameterOutput({
  name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
});

const userData = dataVolume.id.apply((volumeId) => bootstrapScript(volumeId.replace("-", "")));

const instance = new aws.ec2.Instance(
  "box",
  {
    ami: ami.value,
    instanceType,
    subnetId: subnet.id,
    vpcSecurityGroupIds: [securityGroup.id],
    iamInstanceProfile: profile.name,
    metadataOptions: { httpTokens: "required", httpEndpoint: "enabled" },
    rootBlockDevice: { volumeSize: rootVolumeGb, volumeType: "gp3", encrypted: true },
    userData,
    tags,
    volumeTags: tags,
  },
  // A newer AMI or bootstrap script must not replace a running box.
  { ignoreChanges: ["ami", "userData"] },
);

new aws.ec2.VolumeAttachment("data", {
  deviceName: "/dev/sdf",
  instanceId: instance.id,
  volumeId: dataVolume.id,
});

const eip = new aws.ec2.Eip("box", { domain: "vpc", instance: instance.id, tags });

export { boxName };
export const instanceId = instance.id;
export const publicIp = eip.publicIp;
export const runtimeSecretArn = runtimeSecret.arn;
export const appUrl = domains[0] ? `https://${domains[0]}` : pulumi.interpolate`http://${eip.publicIp}`;

function bootstrapScript(volumeIdNoDash: string) {
  return `#!/bin/bash
set -euxo pipefail
NODE_VERSION=24.11.1
CADDY_VERSION=2.8.4

# Node.js and Caddy (official ARM builds)
curl -fsSL "https://nodejs.org/dist/v\${NODE_VERSION}/node-v\${NODE_VERSION}-linux-arm64.tar.xz" | tar -xJ -C /usr/local --strip-components=1
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v\${CADDY_VERSION}/caddy_\${CADDY_VERSION}_linux_arm64.tar.gz" | tar -xz -C /usr/local/bin caddy
useradd --system --home /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy || true
useradd --system --home /opt/app --shell /usr/sbin/nologin app || true
mkdir -p /etc/caddy/sites /opt/app/releases /opt/app/deps
cat > /etc/caddy/Caddyfile <<'CADDY'
import /etc/caddy/sites/*.caddy
CADDY
echo ':80 { respond "starting" 503 }' > /etc/caddy/sites/default.caddy
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target
[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT

# Data volume: formatted once, mounted at /data on every boot.
DEV=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${volumeIdNoDash}
for _ in $(seq 1 120); do [ -e "$DEV" ] && break; sleep 5; done
blkid "$DEV" || mkfs.ext4 -L appdata "$DEV"
mkdir -p /data
grep -q "LABEL=appdata" /etc/fstab || echo "LABEL=appdata /data ext4 defaults,nofail 0 2" >> /etc/fstab
mount -a
chown -R app:app /data /opt/app

# 512 MB swap so small boxes survive memory spikes.
if [ ! -f /swapfile ]; then fallocate -l 512M /swapfile && chmod 600 /swapfile && mkswap /swapfile; fi
grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
swapon -a || true

systemctl daemon-reload
systemctl enable --now caddy
`;
}
