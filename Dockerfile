FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache ffmpeg git

COPY package.json package-lock.json ./
COPY editor/package.json editor/package.json
COPY vendor vendor
RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "start"]
