ARG ALPINE_VERSION=3.21
FROM --platform=linux/386 alpine:${ALPINE_VERSION} AS rootfs
ARG PACKAGES="nodejs python3"
RUN apk add --no-cache ${PACKAGES}
COPY inittab /etc/inittab
COPY wasmbox-net wasmbox-udhcpc-script /usr/local/sbin/
RUN chmod 0755 /usr/local/sbin/wasmbox-net /usr/local/sbin/wasmbox-udhcpc-script \
 && echo wasmbox > /etc/hostname && mkdir -p /proc /sys /dev /run /tmp

FROM alpine:${ALPINE_VERSION} AS builder
ARG IMAGE_SIZE_MIB=512
RUN apk add --no-cache e2fsprogs
COPY --from=rootfs / /rootfs
# resolv.conf は /run（tmpfs）に置く。DHCP のたびにディスクへ書き込まないため。
# （docker build の RUN の中では /etc/resolv.conf が差し替えられているので、ここで作る）
RUN rm -f /rootfs/etc/resolv.conf && ln -s /run/resolv.conf /rootfs/etc/resolv.conf
RUN truncate -s "${IMAGE_SIZE_MIB}M" /rootfs.ext4 \
 && mke2fs -t ext4 -F -q -L wasmbox-root -b 4096 -m 0 \
      -O ^metadata_csum,^64bit,^orphan_file \
      -d /rootfs /rootfs.ext4 \
 && e2fsck -fn /rootfs.ext4

FROM scratch AS image
COPY --from=builder /rootfs.ext4 /rootfs.ext4
