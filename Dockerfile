# Use the official Playwright Linux image matching your package.json version (^1.35.0)
FROM mcr.microsoft.com/playwright:v1.61.1-jammy
# Set the working directory inside the container
WORKDIR /app

# Copy package management files to leverage caching layers
COPY package*.json ./

# Install all standard dependencies
RUN npm install

# Copy the rest of your application code into the image
COPY . .

# Start your Express backend application
CMD ["npm", "start"]